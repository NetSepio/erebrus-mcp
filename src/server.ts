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
        "Auth via wallet/email tools; session stores user PASETO.",
        "VPN tools available after login.",
        "Blocked: admin, rank, leaderboard, perks, social, deep firewall rules.",
      ].join(" "),
    },
  );

  const ctx: ToolContext = { server, client, config: cfg, session };
  registerSessionHealthTools(ctx);
  registerAuthTools(ctx);
  registerOrgTools(ctx);
  registerNodeTools(ctx);
  registerVpnTools(ctx);
  return server;
}
