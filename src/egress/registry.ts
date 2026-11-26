import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { singboxCacheDir } from "./binary.js";

/** One live egress tunnel. */
export interface EgressSession {
  id: string;
  proxyPort: number;
  proxyUrl: string;
  nodeId: string;
  region?: string;
  /** Gateway client row, deleted when the session stops. */
  clientId?: string;
  pid: number;
  startedAt: string;
  /** Egress IP as seen from outside, measured when the session started. */
  egressIp?: string;
  configPath: string;
}

interface RecordedProcess {
  id: string;
  pid: number;
  configPath: string;
}

/**
 * Tracks live egress sessions, caps how many there can be, and cleans up after
 * a process that died without stopping its children.
 *
 * A sing-box left running after the agent disconnects is both a leak — the
 * tunnel and its provisioned peer stay up — and a support ticket, so the pids
 * are written to disk and swept on startup.
 */
export class EgressRegistry {
  private readonly sessions = new Map<string, EgressSession>();
  private readonly stateFile: string;

  constructor(
    readonly maxSessions: number,
    stateFile?: string,
  ) {
    this.stateFile = stateFile ?? join(singboxCacheDir(), "egress-sessions.json");
  }

  list(): EgressSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): EgressSession | undefined {
    return this.sessions.get(id);
  }

  /** Throws when the cap is reached, so a confused agent cannot fork-bomb tunnels. */
  add(session: EgressSession): void {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `already running ${this.sessions.size} egress sessions (EREBRUS_EGRESS_MAX_SESSIONS=${this.maxSessions}); stop one first`,
      );
    }
    this.sessions.set(session.id, session);
    this.persist();
  }

  remove(id: string): EgressSession | undefined {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    this.persist();
    return session;
  }

  private persist(): void {
    const rows: RecordedProcess[] = this.list().map((s) => ({
      id: s.id,
      pid: s.pid,
      configPath: s.configPath,
    }));
    try {
      mkdirSync(singboxCacheDir(), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(rows), { mode: 0o600 });
    } catch {
      // A registry that cannot write its state still works for this process;
      // only the orphan sweep is lost, so this must not fail a tool call.
    }
  }

  /**
   * Kills sing-box processes left by an earlier run of this server.
   *
   * A recorded pid is not enough to kill on: pids are recycled, and killing a
   * stranger's process would be far worse than leaving a tunnel up. So each pid
   * is checked against its command line, and only a process still running the
   * config file this server wrote is killed. Not available on Windows, where
   * there is no cheap equivalent — documented rather than guessed at.
   */
  sweepOrphans(): number {
    let killed = 0;
    let rows: RecordedProcess[] = [];
    try {
      rows = JSON.parse(readFileSync(this.stateFile, "utf8")) as RecordedProcess[];
    } catch {
      return 0;
    }
    for (const row of rows) {
      if (platform() !== "win32" && commandOf(row.pid).includes(row.configPath)) {
        try {
          process.kill(row.pid, "SIGTERM");
          killed += 1;
        } catch {
          // Already gone.
        }
      }
      try {
        rmSync(row.configPath, { force: true });
      } catch {
        // Nothing to clean up.
      }
    }
    try {
      rmSync(this.stateFile, { force: true });
    } catch {
      // Ignore.
    }
    return killed;
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return "";
  }
}
