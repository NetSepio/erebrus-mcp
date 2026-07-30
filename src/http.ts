/**
 * Streamable HTTP MCP transport (stateful sessions).
 * Each MCP session gets its own SessionStore so auth_wallet/email login sticks.
 */
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { createErebrusServer, VERSION } from "./server.js";
import { SessionStore } from "./session.js";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
}

export async function startHttpServer(cfg: Config): Promise<void> {
  const app = createMcpExpressApp();
  const transports: Record<string, SessionEntry> = {};

  // Optional gate on the MCP itself (not the gateway)
  const mcpAuth = cfg.mcpAuthToken;
  app.use("/mcp", (req, res, next) => {
    if (!mcpAuth) return next();
    const hdr = req.headers.authorization ?? "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    if (token !== mcpAuth) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "erebrus-mcp", version: VERSION });
  });

  const mcpPostHandler = async (req: import("express").Request, res: import("express").Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const sessionStore = new SessionStore(cfg.bearerToken, cfg.apiKey);
        const server = createErebrusServer(cfg, sessionStore);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = { transport };
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
    } catch (error) {
      console.error("[erebrus-mcp http]", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", mcpPostHandler);

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(cfg.httpPort, cfg.httpHost, (err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
    server.on("error", reject);
  });

  console.error(
    `[erebrus-mcp] HTTP listening on http://${cfg.httpHost}:${cfg.httpPort}/mcp (v${VERSION})` +
      (mcpAuth ? " [MCP_AUTH_TOKEN required]" : " [open — set MCP_AUTH_TOKEN in prod]"),
  );

  const shutdown = async () => {
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].transport.close();
      } catch {
        /* ignore */
      }
      delete transports[sid];
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
