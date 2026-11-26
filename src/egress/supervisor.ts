import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { singboxCacheDir } from "./binary.js";
import { PROXY_HOST } from "./config.js";

/** Children this process started, so parent death never leaves one running. */
const live = new Set<ChildProcess>();
let hooked = false;

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const child of live) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    live.clear();
  };
  // `exit` covers a clean return and stdio parent death; the signals cover an
  // agent that closes the transport or a container stop. Without these a
  // sing-box outlives the server and keeps proxying.
  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(0);
    });
  }
}

/** A port the OS says is free. */
export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    // Bound on loopback for the same reason the proxy is: never 0.0.0.0, and
    // never a fixed 10808, which the desktop app may already be using.
    server.listen(0, PROXY_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

export interface SupervisorOptions {
  binary: string;
  config: Record<string, unknown>;
  proxyPort: number;
  /** How long to wait for the proxy to accept a connection. */
  readyTimeoutMs?: number;
}

/** A running sing-box, with its config file. */
export class EgressProcess {
  private constructor(
    readonly child: ChildProcess,
    readonly configPath: string,
    readonly proxyPort: number,
  ) {}

  get pid(): number {
    return this.child.pid ?? 0;
  }

  /**
   * Writes the config, starts sing-box and waits until the proxy answers.
   *
   * Waiting matters: an agent that gets a proxy URL back has no other way to
   * know the tunnel carries traffic, and a dead proxy that an HTTP client then
   * falls back from is the worst outcome here.
   */
  static async start(opts: SupervisorOptions): Promise<EgressProcess> {
    hookExit();
    const dir = join(singboxCacheDir(), "sessions");
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, `egress-${randomUUID()}.json`);
    // 0600: the config holds the client's WireGuard private key.
    writeFileSync(configPath, JSON.stringify(opts.config), { mode: 0o600 });

    const child = spawn(opts.binary, ["run", "-c", configPath], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    live.add(child);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      live.delete(child);
    });

    const deadline = Date.now() + (opts.readyTimeoutMs ?? 10_000);
    for (;;) {
      if (exited) {
        rmSync(configPath, { force: true });
        throw new Error(
          `sing-box exited (code ${exited.code ?? "null"}, signal ${exited.signal ?? "none"})` +
            (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""),
        );
      }
      if (await accepts(opts.proxyPort)) {
        return new EgressProcess(child, configPath, opts.proxyPort);
      }
      if (Date.now() > deadline) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
        live.delete(child);
        rmSync(configPath, { force: true });
        throw new Error(
          `the egress proxy did not start listening on ${PROXY_HOST}:${opts.proxyPort}` +
            (stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""),
        );
      }
      await sleep(150);
    }
  }

  /** SIGTERM, then SIGKILL, then remove the config file. */
  async stop(graceMs = 3000): Promise<void> {
    live.delete(this.child);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      const deadline = Date.now() + graceMs;
      while (this.child.exitCode === null && this.child.signalCode === null) {
        if (Date.now() > deadline) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          break;
        }
        await sleep(100);
      }
    }
    rmSync(this.configPath, { force: true });
  }
}

/** Whether something accepts a TCP connection on this loopback port. */
export function accepts(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: PROXY_HOST, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
