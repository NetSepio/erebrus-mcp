import { z } from "zod";
import { toolResult } from "../util/result.js";
import { mapError } from "../util/errors.js";
import type { ToolContext } from "./context.js";

export function registerOrgTools(ctx: ToolContext): void {
  const { server, client } = ctx;

  server.registerTool(
    "org_create",
    {
      title: "Create organization",
      description: "Create an organization; caller becomes owner. Requires user session/Bearer.",
      inputSchema: {
        name: z.string().min(1).describe("Display name"),
        slug: z.string().optional().describe("Optional URL slug"),
      },
      annotations: { openWorldHint: true },
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
              "Save org id",
              "apikey_create for programmatic access",
              "node_registration_token_create to enroll infrastructure",
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
      description: "List organizations for the authenticated user.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const orgs = await client.request<unknown>({ path: "/api/v2/orgs", auth: "bearer" });
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
      description: "Get one organization by id.",
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
      description: "Plan entitlements / limits for an org.",
      inputSchema: {
        org_id: z.string().optional(),
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

  server.registerTool(
    "apikey_create",
    {
      title: "Create org API key",
      description:
        "Mint org API key (returned ONCE). Owner only. Useful for long-lived machine VPN/usage via X-Api-Key.",
      inputSchema: {
        org_id: z.string().optional(),
        name: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ org_id, name }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const created = await client.request<Record<string, unknown>>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/apikeys`,
          method: "POST",
          auth: "bearer",
          body: name ? { name } : {},
        });
        return toolResult(
          {
            org_id: id,
            ...created,
            warning: "api_key shown once — store offline; gateway only keeps a hash.",
          },
          {
            nextSteps: [
              "Set EREBRUS_API_KEY for org-scoped VPN/usage tools",
              "node_registration_token_create still needs user session today",
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
      description: "List key metadata (prefixes only).",
      inputSchema: { org_id: z.string().optional() },
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
      description: "Revoke API key by id. Owner only.",
      inputSchema: {
        org_id: z.string().optional(),
        key_id: z.string().min(1),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ org_id, key_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        await client.request({
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
}
