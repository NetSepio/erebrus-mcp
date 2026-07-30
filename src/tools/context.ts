import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayClient } from "../client/gateway.js";
import type { Config } from "../config.js";
import type { SessionStore } from "../session.js";

export interface ToolContext {
  server: McpServer;
  client: GatewayClient;
  config: Config;
  session: SessionStore;
}
