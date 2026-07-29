import type { Config } from "../config.js";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type AuthPreference = "bearer" | "api_key" | "auto" | "none";

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Which credential to send. Default auto: bearer if set, else api_key. */
  auth?: AuthPreference;
  /** Override Accept / extra headers */
  headers?: Record<string, string>;
}

/**
 * Thin HTTPS client for gateway.erebrus.io.
 * Path allowlist is enforced so tools cannot reach admin/rank/social by accident.
 */
export class GatewayClient {
  constructor(private readonly cfg: Config) {}

  get config(): Config {
    return this.cfg;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    assertPathAllowed(opts.path);

    const url = new URL(opts.path.startsWith("http") ? opts.path : `${this.cfg.gatewayUrl}${opts.path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "erebrus-mcp/0.1.0",
      ...opts.headers,
    };

    const auth = opts.auth ?? "auto";
    if (auth === "bearer" || (auth === "auto" && this.cfg.bearerToken)) {
      if (!this.cfg.bearerToken) {
        throw new GatewayError("EREBRUS_BEARER_TOKEN is required for this operation", 401, null);
      }
      headers.Authorization = `Bearer ${this.cfg.bearerToken}`;
    } else if (auth === "api_key" || (auth === "auto" && this.cfg.apiKey && !this.cfg.bearerToken)) {
      if (!this.cfg.apiKey) {
        throw new GatewayError("EREBRUS_API_KEY is required for this operation", 401, null);
      }
      headers["X-Api-Key"] = this.cfg.apiKey;
    }

    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `gateway ${res.status} ${res.statusText}`;
      throw new GatewayError(msg, res.status, parsed);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return parsed as T;
  }

  resolveOrgId(orgId?: string): string {
    const id = (orgId ?? this.cfg.defaultOrgId ?? "").trim();
    if (!id) {
      throw new GatewayError(
        "org_id is required (pass org_id or set EREBRUS_DEFAULT_ORG_ID)",
        400,
        null,
      );
    }
    return id;
  }
}

/** Paths tools may call. Admin / rank / social / leaderboard / perks are excluded. */
const ALLOWED_PREFIXES = [
  "/healthz",
  "/readyz",
  "/version",
  "/api/v2/account/",
  "/api/v2/orgs",
  "/api/v2/nodes",
  "/api/v2/operator/nodes",
  "/api/v2/vpn/",
  "/api/v2/org/",
  "/api/v2/drop/",
  "/api/v2/public/orgs/",
  "/api/v2/subscriptions/plans",
];

const DENIED_SUBSTRINGS = [
  "/admin",
  "/rank",
  "/leaderboard",
  "/perks",
  "/social/",
  "/referrals",
  "/firewall/rules",
];

export function assertPathAllowed(path: string): void {
  const p = path.startsWith("http") ? new URL(path).pathname : path.split("?")[0] ?? path;

  for (const bad of DENIED_SUBSTRINGS) {
    if (p.includes(bad)) {
      throw new GatewayError(`path not allowed by erebrus-mcp policy: ${p}`, 403, null);
    }
  }

  const ok = ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
  if (!ok) {
    throw new GatewayError(`path not on MCP allowlist: ${p}`, 403, null);
  }
}
