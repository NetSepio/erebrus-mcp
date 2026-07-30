#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createErebrusServer } from "./server.js";
import { SessionStore } from "./session.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const session = new SessionStore(cfg.bearerToken, cfg.apiKey);
  const server = createErebrusServer(cfg, session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("[erebrus-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
