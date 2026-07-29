#!/usr/bin/env node
/**
 * erebrus-mcp — stdio MCP server entrypoint.
 *
 * Configure credentials via env (see .env.example). Do not log secrets.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createErebrusServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = createErebrusServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  // stderr only — stdout is the MCP channel
  console.error("[erebrus-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
