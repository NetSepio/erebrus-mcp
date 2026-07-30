import { toolResult } from "../util/result.js";
import { mapError } from "../util/errors.js";
import type { ToolContext } from "./context.js";

export function registerSessionHealthTools(ctx: ToolContext): void {
  const { server, client, config, session } = ctx;

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
          gateway_url: config.gatewayUrl,
          healthz,
          readyz,
          version,
          session: session.snapshot(),
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
        "Authenticated user profile. Uses MCP session token or EREBRUS_BEARER_TOKEN. " +
        "If unauthenticated, returns session status + how to log in.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const snap = session.snapshot();
      if (!session.getBearer()) {
        return toolResult(
          { session: snap, profile: null },
          {
            nextSteps: [
              "auth_wallet_challenge → sign → auth_wallet_complete",
              "or auth_email_login_start → OTP → auth_email_login_verify",
              "or auth_import_token / set EREBRUS_BEARER_TOKEN for CI",
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
          { session: snap, profile },
          {
            nextSteps: [
              "org_list or org_create",
              "apikey_create for long-lived org API key",
              "node_registration_token_create to enroll a node",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );
}
