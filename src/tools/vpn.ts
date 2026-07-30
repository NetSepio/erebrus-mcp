import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toolResult } from "../util/result.js";
import { mapError } from "../util/errors.js";
import type { ToolContext } from "./context.js";

export function registerVpnTools(ctx: ToolContext): void {
  const { server, client } = ctx;

  server.registerTool(
    "vpn_client_list",
    {
      title: "List VPN clients",
      description: "List VPN clients for the authenticated user (Bearer session).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const clients = await client.request<unknown>({
          path: "/api/v2/vpn/clients",
          auth: "bearer",
        });
        return toolResult({ clients });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "vpn_client_create",
    {
      title: "Provision VPN client",
      description:
        "Provision a VPN client on a node. Requires name, node_id, and client WireGuard public key. " +
        "User needs org membership (public nodes) or node org membership (private).",
      inputSchema: {
        name: z.string().min(1).describe("Client/device label"),
        node_id: z.string().min(1).describe("Target node peer id"),
        wg_public_key: z.string().min(1).describe("Client WireGuard public key"),
        wg_preshared_key: z.string().optional(),
        idempotency_key: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ name, node_id, wg_public_key, wg_preshared_key, idempotency_key }) => {
      try {
        const body: Record<string, string> = {
          name,
          node_id,
          wg_public_key,
          idempotency_key: idempotency_key ?? randomUUID(),
        };
        if (wg_preshared_key) body.wg_preshared_key = wg_preshared_key;
        const clientRow = await client.request<unknown>({
          path: "/api/v2/vpn/clients",
          method: "POST",
          auth: "bearer",
          body,
        });
        return toolResult(
          { client: clientRow },
          {
            nextSteps: [
              "vpn_client_get_config with the client id for the WireGuard/stealth config",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "vpn_client_get_config",
    {
      title: "Get VPN client config",
      description: "Fetch WireGuard/credentials config for a client (owner/admin).",
      inputSchema: {
        client_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ client_id }) => {
      try {
        const config = await client.request<unknown>({
          path: `/api/v2/vpn/clients/${encodeURIComponent(client_id)}/config`,
          auth: "bearer",
        });
        return toolResult({
          client_id,
          config,
          warning: "Config may contain secrets — do not log or commit.",
        });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "vpn_client_delete",
    {
      title: "Delete VPN client",
      description: "Delete a VPN client by id.",
      inputSchema: { client_id: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ client_id }) => {
      try {
        await client.request({
          path: `/api/v2/vpn/clients/${encodeURIComponent(client_id)}`,
          method: "DELETE",
          auth: "bearer",
        });
        return toolResult({ client_id, deleted: true });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_vpn_client_create",
    {
      title: "Org API — provision VPN client",
      description:
        "Provision via org API key route POST /api/v2/org/vpn/clients (X-Api-Key). " +
        "Requires EREBRUS_API_KEY. Node must belong to the key's org.",
      inputSchema: {
        name: z.string().min(1),
        node_id: z.string().min(1),
        wg_public_key: z.string().min(1),
        wg_preshared_key: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ name, node_id, wg_public_key, wg_preshared_key }) => {
      try {
        const body: Record<string, string> = { name, node_id, wg_public_key };
        if (wg_preshared_key) body.wg_preshared_key = wg_preshared_key;
        const clientRow = await client.request<unknown>({
          path: "/api/v2/org/vpn/clients",
          method: "POST",
          auth: "api_key",
          body,
        });
        return toolResult({ client: clientRow });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_vpn_client_list",
    {
      title: "Org API — list VPN clients",
      description: "List clients for the API key's org (GET /api/v2/org/vpn/clients).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const clients = await client.request<unknown>({
          path: "/api/v2/org/vpn/clients",
          auth: "api_key",
        });
        return toolResult({ clients });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_usage",
    {
      title: "Org API — usage",
      description: "Org usage via X-Api-Key (GET /api/v2/org/usage) or user Bearer on /orgs/{id}/usage.",
      inputSchema: {
        org_id: z
          .string()
          .optional()
          .describe("If set, use user Bearer on /orgs/{id}/usage; else org API key self usage"),
        period: z.string().optional().describe("Billing period e.g. 2026-06"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id, period }) => {
      try {
        if (org_id || client.config.defaultOrgId) {
          const id = client.resolveOrgId(org_id);
          const usage = await client.request<unknown>({
            path: `/api/v2/orgs/${encodeURIComponent(id)}/usage`,
            auth: "bearer",
            query: period ? { period } : undefined,
          });
          return toolResult({ org_id: id, usage });
        }
        const usage = await client.request<unknown>({
          path: "/api/v2/org/usage",
          auth: "api_key",
        });
        return toolResult({ usage });
      } catch (e) {
        return mapError(e);
      }
    },
  );
}
