import { z } from "zod";
import { toolResult } from "../util/result.js";
import { mapError } from "../util/errors.js";
import { buildNodeInstallPlan } from "./runbook.js";
import type { ToolContext } from "./context.js";

export function registerNodeTools(ctx: ToolContext): void {
  const { server, client, config } = ctx;

  server.registerTool(
    "node_registration_token_create",
    {
      title: "Mint node registration token",
      description: "Create ere_reg_* token for node install. Returned once. Requires user session.",
      inputSchema: {
        org_id: z.string().optional(),
        ttl_hours: z.number().int().positive().max(24 * 30).optional(),
        peer_id: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ org_id, ttl_hours, peer_id, scopes }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const body: Record<string, unknown> = {};
        if (ttl_hours) body.ttl_hours = ttl_hours;
        if (peer_id) body.peer_id = peer_id;
        if (scopes?.length) body.scopes = scopes;
        const created = await client.request<Record<string, unknown>>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/node-registration-tokens`,
          method: "POST",
          auth: "bearer",
          body,
        });
        return toolResult(
          {
            org_id: id,
            ...created,
            warning: "registration token is secret — pass only to node_install_plan / installer.",
          },
          {
            nextSteps: [
              "node_install_plan with this token",
              "After host install, org_nodes_list to verify",
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
      description: "List nodes registered to the org control plane.",
      inputSchema: { org_id: z.string().optional() },
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
      description: "Get one org control-plane node by id.",
      inputSchema: {
        org_id: z.string().optional(),
        node_id: z.string().min(1),
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
      description: "Runtime VPN nodes for orgs the caller belongs to (includes private).",
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
      description: "Public node directory (GET /api/v2/nodes).",
      inputSchema: {
        region: z.string().optional(),
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
        "Build install command + port checklist. Does not SSH. Needs a registration token string.",
      inputSchema: {
        registration_token: z.string().min(1),
        access: z.enum(["public", "private"]),
        profile: z.enum(["standard", "shield", "sentinel"]).optional(),
        drop: z.boolean().optional(),
        node_name: z.string().optional(),
        region: z.string().optional(),
        zone: z.string().optional(),
        skip_checks: z.boolean().optional(),
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
        gatewayUrl: config.gatewayUrl,
      });
      return toolResult(plan);
    },
  );
}
