import { accessSync, constants } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The sing-box build this server's config shape is written against. The app
 * pins the same version, and 1.11.x rejects unknown DNS fields at decode, so a
 * newer or older binary can refuse a config this builds.
 */
export const SINGBOX_VERSION = "1.11.15";

/** Where a hosted or packaged install is expected to keep the binary. */
export function singboxCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    platform() === "darwin"
      ? join(homedir(), "Library", "Caches")
      : platform() === "win32"
        ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "erebrus-mcp");
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the sing-box binary: explicit path, then the cache dir, then PATH.
 *
 * Downloading it is deliberately not done here. A download needs a per-platform
 * checksum pinned against the release, and an unverified binary that proxies
 * all of an agent's traffic is a worse outcome than a clear error — so the
 * error says exactly what to do instead, and the Docker image bakes the binary
 * in so the hosted path never needs this.
 */
export function resolveSingboxPath(env: NodeJS.ProcessEnv = process.env): string {
  const exe = platform() === "win32" ? "sing-box.exe" : "sing-box";
  const explicit = (env.EREBRUS_SINGBOX_PATH ?? "").trim();
  if (explicit) {
    if (!executable(explicit)) {
      throw new Error(`EREBRUS_SINGBOX_PATH is set to ${explicit}, which is not executable`);
    }
    return explicit;
  }

  const cached = join(singboxCacheDir(env), `sing-box-${SINGBOX_VERSION}`, exe);
  if (executable(cached)) return cached;

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (executable(candidate)) return candidate;
  }

  throw new Error(
    [
      `sing-box ${SINGBOX_VERSION} was not found, so no egress can be started.`,
      "Fix it one of three ways:",
      `  • set EREBRUS_SINGBOX_PATH to the binary`,
      `  • install sing-box ${SINGBOX_VERSION} on PATH`,
      `  • put it at ${cached}`,
      "The published Docker image ships with it already.",
    ].join("\n"),
  );
}
