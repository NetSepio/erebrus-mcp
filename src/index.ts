#!/usr/bin/env node
/**
 * erebrus-mcp entrypoint.
 *
 *   node dist/index.js              # stdio (default)
 *   node dist/index.js --http       # streamable HTTP
 *   MCP_TRANSPORT=http node dist/index.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createErebrusServer } from "./server.js";
import { SessionStore } from "./session.js";
import { startHttpServer } from "./http.js";

function wantHttp(argv: string[]): boolean {
  if (argv.includes("--http") || argv.includes("-H")) return true;
  const t = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  return t === "http" || t === "streamable-http" || t === "sse";
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (wantHttp(process.argv.slice(2))) {
    await startHttpServer(cfg);
    return;
  }

  const session = new SessionStore(cfg.bearerToken, cfg.apiKey);
  const server = createErebrusServer(cfg, session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("[erebrus-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
