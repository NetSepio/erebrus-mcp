import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeAuth, loadConfig, type Config } from "./config.js";
import { GatewayClient, GatewayError } from "./client/gateway.js";
import { toolError, toolResult } from "./util/result.js";
import { buildNodeInstallPlan } from "./tools/runbook.js";

const VERSION = "0.1.0";

export function createErebrusServer(cfg: Config = loadConfig()): McpServer {
  const client = new GatewayClient(cfg);
  const server = new McpServer(
    {
      name: "erebrus-mcp",
      version: VERSION,
      websiteUrl: "https://github.com/NetSepio/erebrus-mcp",
    },
    {
      instructions: [
        "Erebrus gateway MCP for agent onboarding.",
        "Prefer EREBRUS_BEARER_TOKEN (user PASETO) for org/API-key/node-token tools.",
        "Org X-Api-Key only works on /api/v2/org/* (VPN/usage) today.",
        "Never use admin, rank, leaderboard, perks, social, or deep firewall tools — they are blocked.",
        "Typical flow: whoami → org_create → apikey_create → node_registration_token_create → node_install_plan → org_nodes_list.",
      ].join(" "),
    },
  );

  // ── Session / health ───────────────────────────────────────────

  server.registerTool(
    "gateway_health",
    {
      title: "Gateway health",
      description: "Check gateway liveness, readiness, and build version (public, no auth).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const [healthz, readyz, version] = await Promise.all([
          client.request<unknown>({ path: "/healthz", auth: "none" }),
          client.request<unknown>({ path: "/readyz", auth: "none" }).catch((e) => ({
            error: String(e),
          })),
          client.request<unknown>({ path: "/version", auth: "none" }).catch((e) => ({
            error: String(e),
          })),
        ]);
        return toolResult({
          gateway_url: cfg.gatewayUrl,
          healthz,
          readyz,
          version,
          auth: describeAuth(cfg),
        });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return authenticated user profile (Bearer) and/or auth configuration status. " +
        "Requires EREBRUS_BEARER_TOKEN for profile data.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const auth = describeAuth(cfg);
      if (!cfg.bearerToken) {
        return toolResult(
          { auth, profile: null },
          {
            nextSteps: [
              "Set EREBRUS_BEARER_TOKEN from a wallet/social login (POST /api/v2/auth).",
              "Then retry whoami and org_create.",
            ],
          },
        );
      }
      try {
        const profile = await client.request<unknown>({
          path: "/api/v2/account/profile",
          auth: "bearer",
        });
        return toolResult(
          { auth, profile },
          {
            nextSteps: [
              "List orgs with org_list, or create one with org_create.",
              "Mint an org API key with apikey_create for programmatic VPN/usage later.",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  // ── Orgs ───────────────────────────────────────────────────────

  server.registerTool(
    "org_create",
    {
      title: "Create organization",
      description: "Create an organization; caller becomes owner. Requires user Bearer token.",
      inputSchema: {
        name: z.string().min(1).describe("Display name"),
        slug: z
          .string()
          .optional()
          .describe("Optional URL slug; gateway may derive from name if omitted"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ name, slug }) => {
      try {
        const org = await client.request<unknown>({
          path: "/api/v2/orgs",
          method: "POST",
          auth: "bearer",
          body: slug ? { name, slug } : { name },
        });
        return toolResult(
          { org },
          {
            nextSteps: [
              "Save org id from the response.",
              "Optionally apikey_create for this org.",
              "node_registration_token_create to enroll a VPN/Drop node.",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_list",
    {
      title: "List organizations",
      description: "List organizations for the authenticated user. Requires Bearer token.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const orgs = await client.request<unknown>({
          path: "/api/v2/orgs",
          auth: "bearer",
        });
        return toolResult({ orgs });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_get",
    {
      title: "Get organization",
      description: "Get one organization by id. Requires Bearer token and membership.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const org = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}`,
          auth: "bearer",
        });
        return toolResult({ org });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_entitlements",
    {
      title: "Org entitlements",
      description: "Plan entitlements / limits for an org. Requires Bearer token.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const entitlements = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/entitlements`,
          auth: "bearer",
        });
        return toolResult({ org_id: id, entitlements });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  // ── API keys ───────────────────────────────────────────────────

  server.registerTool(
    "apikey_create",
    {
      title: "Create org API key",
      description:
        "Mint an org API key (returned ONCE as api_key). Owner only. " +
        "Store securely — only a hash is kept server-side. Requires Bearer token.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
        name: z.string().optional().describe("Optional key label"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ org_id, name }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const created = await client.request<{ api_key?: string; key?: unknown }>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/apikeys`,
          method: "POST",
          auth: "bearer",
          body: name ? { name } : {},
        });
        return toolResult(
          {
            org_id: id,
            ...created,
            warning: "api_key is shown once. Save it now; it cannot be retrieved again.",
          },
          {
            nextSteps: [
              "Store api_key as EREBRUS_API_KEY for org-scoped VPN/usage clients.",
              "Use node_registration_token_create to enroll infrastructure nodes.",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "apikey_list",
    {
      title: "List org API keys",
      description: "List API key metadata (prefixes only, no secrets). Privileged org role. Bearer required.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const keys = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/apikeys`,
          auth: "bearer",
        });
        return toolResult({ org_id: id, keys });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "apikey_revoke",
    {
      title: "Revoke org API key",
      description: "Revoke an API key by id. Owner only. Requires Bearer token.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
        key_id: z.string().min(1).describe("API key id to revoke"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ org_id, key_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/apikeys/${encodeURIComponent(key_id)}`,
          method: "DELETE",
          auth: "bearer",
        });
        return toolResult({ org_id: id, key_id, revoked: true });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  // ── Nodes ──────────────────────────────────────────────────────

  server.registerTool(
    "node_registration_token_create",
    {
      title: "Mint node registration token",
      description:
        "Create an ere_reg_* token for node install (POST …/node-registration-tokens). " +
        "Token is returned once. Requires Bearer + node-manage role.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
        ttl_hours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .describe("Token lifetime in hours (default 24)"),
        peer_id: z
          .string()
          .optional()
          .describe("Optional bind to a specific libp2p peer id"),
        scopes: z.array(z.string()).optional().describe("Optional scopes; gateway default if omitted"),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ org_id, ttl_hours, peer_id, scopes }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const body: Record<string, unknown> = {};
        if (ttl_hours) body.ttl_hours = ttl_hours;
        if (peer_id) body.peer_id = peer_id;
        if (scopes?.length) body.scopes = scopes;

        const created = await client.request<{ token?: string; token_meta?: unknown }>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/node-registration-tokens`,
          method: "POST",
          auth: "bearer",
          body,
        });
        return toolResult(
          {
            org_id: id,
            ...created,
            warning: "registration token is secret and returned once — pass to node_install_plan / installer only.",
          },
          {
            nextSteps: [
              "Call node_install_plan with this token, access mode, and optional --drop.",
              "After install, confirm with org_nodes_list.",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_nodes_list",
    {
      title: "List org control-plane nodes",
      description: "List nodes registered to the org control plane. Requires Bearer + membership.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const nodes = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/nodes`,
          auth: "bearer",
        });
        return toolResult({ org_id: id, nodes });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_node_get",
    {
      title: "Get org node",
      description: "Get one org control-plane node by id. Requires Bearer + membership.",
      inputSchema: {
        org_id: z.string().optional().describe("Org id; defaults to EREBRUS_DEFAULT_ORG_ID"),
        node_id: z.string().min(1).describe("Node id (usually libp2p peer id)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id, node_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const node = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/nodes/${encodeURIComponent(node_id)}`,
          auth: "bearer",
        });
        return toolResult({ org_id: id, node });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "operator_nodes_list",
    {
      title: "List operator runtime nodes",
      description:
        "Runtime VPN nodes for orgs the caller belongs to (includes private). Requires Bearer.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const nodes = await client.request<unknown>({
          path: "/api/v2/operator/nodes",
          auth: "bearer",
        });
        return toolResult({ nodes });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "nodes_directory",
    {
      title: "Public node directory",
      description: "Public node directory (GET /api/v2/nodes). No auth required.",
      inputSchema: {
        region: z.string().optional().describe("Optional region filter if supported by gateway"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ region }) => {
      try {
        const nodes = await client.request<unknown>({
          path: "/api/v2/nodes",
          auth: "none",
          query: region ? { region } : undefined,
        });
        return toolResult({ nodes });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "node_install_plan",
    {
      title: "Node install runbook",
      description:
        "Build an install command + port checklist for a standard/shield/sentinel node " +
        "(optional Drop). Does not SSH or execute remotely. Requires a registration token.",
      inputSchema: {
        registration_token: z
          .string()
          .min(1)
          .describe("ere_reg_* token from node_registration_token_create"),
        access: z.enum(["public", "private"]).describe("Gateway directory visibility"),
        profile: z
          .enum(["standard", "shield", "sentinel"])
          .optional()
          .describe("Deployment profile (default standard)"),
        drop: z.boolean().optional().describe("Enable Erebrus Drop (Kubo) sidecar"),
        node_name: z.string().optional().describe("NODE_NAME label, e.g. icarus-au01"),
        region: z.string().optional().describe("REGION country code, e.g. AU"),
        zone: z.string().optional().describe("ZONE free-form label, e.g. sydney"),
        skip_checks: z
          .boolean()
          .optional()
          .describe("Pass --skip-checks to installer (use if cloud firewall blocks probes)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const plan = buildNodeInstallPlan({
        registrationToken: args.registration_token,
        access: args.access,
        profile: args.profile,
        drop: args.drop,
        nodeName: args.node_name,
        region: args.region,
        zone: args.zone,
        skipChecks: args.skip_checks,
        gatewayUrl: cfg.gatewayUrl,
      });
      return toolResult(plan);
    },
  );

  return server;
}

function mapError(e: unknown) {
  if (e instanceof GatewayError) {
    return toolError(e.message, { status: e.status, body: e.body });
  }
  return toolError(e instanceof Error ? e.message : String(e));
}
