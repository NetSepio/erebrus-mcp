import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { GatewayClient } from "./client/gateway.js";
import { SessionStore } from "./session.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerSessionHealthTools } from "./tools/session_health.js";
import { registerOrgTools } from "./tools/org.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerVpnTools } from "./tools/vpn.js";
import { registerDropTools } from "./tools/drop.js";
import type { ToolContext } from "./tools/context.js";

export const VERSION = "0.2.0";

export function createErebrusServer(
  cfg: Config = loadConfig(),
  session: SessionStore = new SessionStore(cfg.bearerToken, cfg.apiKey),
): McpServer {
  const client = new GatewayClient(cfg, session);
  const server = new McpServer(
    {
      name: "erebrus-mcp",
      version: VERSION,
      websiteUrl: "https://github.com/NetSepio/erebrus-mcp",
    },
    {
      instructions: [
        "Erebrus gateway MCP for agent self-onboarding.",
        "Auth: auth_wallet_challenge → sign → auth_wallet_complete, or auth_email_login_start → OTP → auth_email_login_verify.",
        "Session stores the user PASETO; EREBRUS_BEARER_TOKEN is optional env fallback.",
        "Flow: auth → org_create → apikey_create → node_registration_token_create → node_install_plan → vpn/drop tools.",
        "Blocked: admin, rank, leaderboard, perks, social, deep firewall rules, billing webhooks.",
      ].join(" "),
    },
  );

  const ctx: ToolContext = { server, client, config: cfg, session };
  registerSessionHealthTools(ctx);
  registerAuthTools(ctx);
  registerOrgTools(ctx);
  registerNodeTools(ctx);
  registerVpnTools(ctx);
  registerDropTools(ctx);

  return server;
}
