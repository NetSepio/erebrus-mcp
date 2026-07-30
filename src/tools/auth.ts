import { z } from "zod";
import { toolResult } from "../util/result.js";
import { mapError } from "../util/errors.js";
import type { ToolContext } from "./context.js";

export function registerAuthTools(ctx: ToolContext): void {
  const { server, client, session } = ctx;

  server.registerTool(
    "auth_methods",
    {
      title: "List auth methods",
      description: "Which login methods the gateway has configured (public).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const methods = await client.request<unknown>({
          path: "/api/v2/auth/methods",
          auth: "none",
        });
        return toolResult({ methods, session: session.snapshot() });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "auth_status",
    {
      title: "Auth session status",
      description:
        "Show whether this MCP session has a user PASETO (from login tools or EREBRUS_BEARER_TOKEN fallback).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      toolResult({
        session: session.snapshot(),
        note:
          "Agents should call auth_wallet_challenge → sign → auth_wallet_complete, " +
          "or auth_email_login_start → OTP → auth_email_login_verify. " +
          "EREBRUS_BEARER_TOKEN is optional env fallback for operators/CI.",
      }),
  );

  server.registerTool(
    "auth_wallet_challenge",
    {
      title: "Wallet login challenge",
      description:
        "Start wallet-signature login (GET /api/v2/auth). Returns flow_id + message to sign with the wallet.",
      inputSchema: {
        wallet_address: z.string().min(1).describe("Wallet address (EVM or Solana)"),
        chain: z.enum(["evm", "sol"]).describe("Wallet chain"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ wallet_address, chain }) => {
      try {
        const challenge = await client.request<{ flow_id?: string; message?: string }>({
          path: "/api/v2/auth",
          auth: "none",
          query: { wallet_address, chain },
        });
        return toolResult(
          { challenge },
          {
            nextSteps: [
              "Sign challenge.message with the wallet (chain-appropriate scheme).",
              "For Solana include public_key when calling auth_wallet_complete.",
              "Call auth_wallet_complete with flow_id + signature.",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "auth_wallet_complete",
    {
      title: "Complete wallet login",
      description:
        "Complete wallet login (POST /api/v2/auth). Stores the PASETO in this MCP session for subsequent tools.",
      inputSchema: {
        flow_id: z.string().min(1),
        signature: z.string().min(1).describe("Signature over the challenge message"),
        public_key: z.string().optional().describe("Required for Solana"),
        ref: z.string().optional().describe("Optional referral code on first signup"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ flow_id, signature, public_key, ref }) => {
      try {
        const body: Record<string, string> = { flow_id, signature };
        if (public_key) body.public_key = public_key;
        if (ref) body.ref = ref;
        const res = await client.request<{ token?: string; user_id?: string; role?: string }>({
          path: "/api/v2/auth",
          method: "POST",
          auth: "none",
          body,
        });
        if (!res.token) {
          return toolResult({ error: "gateway did not return token", res }, { isError: true });
        }
        session.setSession(res.token, {
          userId: res.user_id,
          role: res.role,
          source: "wallet",
        });
        return toolResult(
          {
            logged_in: true,
            user_id: res.user_id,
            role: res.role,
            session: session.snapshot(),
            token: res.token,
            warning:
              "token stored in MCP session and returned once here — prefer session; do not log the full token.",
          },
          {
            nextSteps: ["whoami", "org_list or org_create", "apikey_create / node_registration_token_create"],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "auth_email_login_start",
    {
      title: "Email login — send OTP",
      description:
        "Passwordless email login: send a 6-digit OTP (POST /api/v2/auth/email/login/start). Public; no prior session.",
      inputSchema: {
        email: z.string().email(),
        app: z.string().optional().describe('Product name in the email, e.g. "Erebrus MCP"'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ email, app }) => {
      try {
        const res = await client.request<unknown>({
          path: "/api/v2/auth/email/login/start",
          method: "POST",
          auth: "none",
          body: app ? { email, app } : { email },
        });
        return toolResult(
          { email, result: res },
          {
            nextSteps: [
              "Read the OTP from the mailbox (human or mail API).",
              "Call auth_email_login_verify with email + code.",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "auth_email_login_verify",
    {
      title: "Email login — verify OTP",
      description:
        "Verify email OTP and log in (POST /api/v2/auth/email/login/verify). Stores PASETO in MCP session.",
      inputSchema: {
        email: z.string().email(),
        code: z.string().min(4).describe("6-digit OTP from email"),
        ref: z.string().optional().describe("Optional referral code"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ email, code, ref }) => {
      try {
        const body: Record<string, string> = { email, code };
        if (ref) body.ref = ref;
        const res = await client.request<{ token?: string; user_id?: string; role?: string }>({
          path: "/api/v2/auth/email/login/verify",
          method: "POST",
          auth: "none",
          body,
        });
        if (!res.token) {
          return toolResult({ error: "gateway did not return token", res }, { isError: true });
        }
        session.setSession(res.token, {
          userId: res.user_id,
          role: res.role,
          source: "email",
        });
        return toolResult(
          {
            logged_in: true,
            user_id: res.user_id,
            role: res.role,
            session: session.snapshot(),
            token: res.token,
            warning: "token stored in MCP session; treat as secret.",
          },
          { nextSteps: ["whoami", "org_list or org_create"] },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "auth_import_token",
    {
      title: "Import existing PASETO",
      description:
        "Store an already-issued user PASETO in this MCP session (e.g. from a previous login). Prefer wallet/email tools for agents.",
      inputSchema: {
        token: z.string().min(10).describe("User PASETO bearer token"),
        user_id: z.string().optional(),
      },
      annotations: { openWorldHint: false },
    },
    async ({ token, user_id }) => {
      session.setSession(token, { userId: user_id, source: "import" });
      return toolResult({
        logged_in: true,
        session: session.snapshot(),
      });
    },
  );

  server.registerTool(
    "auth_logout",
    {
      title: "Clear session token",
      description:
        "Clear the MCP session PASETO. Env EREBRUS_BEARER_TOKEN fallback (if set) still applies until process exit.",
      inputSchema: {},
      annotations: { openWorldHint: false },
    },
    async () => {
      session.clearSession();
      return toolResult({ logged_out: true, session: session.snapshot() });
    },
  );
}
