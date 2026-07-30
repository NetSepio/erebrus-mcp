import type { Config } from "../config.js";
import type { SessionStore } from "../session.js";

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
  /** Raw body (e.g. binary upload). Mutually exclusive with JSON body. */
  rawBody?: ArrayBuffer | Uint8Array | Buffer;
  contentType?: string;
  auth?: AuthPreference;
  headers?: Record<string, string>;
  /** Return response as text/bytes instead of JSON */
  responseType?: "json" | "text" | "arrayBuffer";
}

export class GatewayClient {
  constructor(
    private readonly cfg: Config,
    private readonly session: SessionStore,
  ) {}

  get config(): Config {
    return this.cfg;
  }

  get sessionStore(): SessionStore {
    return this.session;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    assertPathAllowed(opts.path);

    const url = new URL(
      opts.path.startsWith("http") ? opts.path : `${this.cfg.gatewayUrl}${opts.path}`,
    );
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: opts.responseType === "arrayBuffer" ? "*/*" : "application/json",
      "User-Agent": "erebrus-mcp/0.2.0",
      ...opts.headers,
    };

    const auth = opts.auth ?? "auto";
    const bearer = this.session.getBearer();
    const apiKey = this.session.getApiKey();

    if (auth === "bearer" || (auth === "auto" && bearer)) {
      if (!bearer) {
        throw new GatewayError(
          "Not authenticated. Use auth_wallet_* / auth_email_* tools, or set EREBRUS_BEARER_TOKEN.",
          401,
          null,
        );
      }
      headers.Authorization = `Bearer ${bearer}`;
    } else if (auth === "api_key" || (auth === "auto" && apiKey && !bearer)) {
      if (!apiKey) {
        throw new GatewayError("EREBRUS_API_KEY is required for this operation", 401, null);
      }
      headers["X-Api-Key"] = apiKey;
    }

    let body: string | Uint8Array | Buffer | undefined;
    if (opts.rawBody !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
      body =
        opts.rawBody instanceof ArrayBuffer
          ? Buffer.from(opts.rawBody)
          : (opts.rawBody as Uint8Array | Buffer);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, {
      method: opts.method ?? (body !== undefined ? "POST" : "GET"),
      headers,
      body,
    });

    if (res.status === 204) {
      return undefined as T;
    }

    if (opts.responseType === "arrayBuffer") {
      if (!res.ok) {
        const text = await res.text();
        throw new GatewayError(text || `gateway ${res.status}`, res.status, text);
      }
      return (await res.arrayBuffer()) as T;
    }

    if (opts.responseType === "text") {
      const text = await res.text();
      if (!res.ok) throw new GatewayError(text || `gateway ${res.status}`, res.status, text);
      return text as T;
    }

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

const ALLOWED_PREFIXES = [
  "/healthz",
  "/readyz",
  "/version",
  "/api/v2/auth",
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
  const p = path.startsWith("http") ? new URL(path).pathname : (path.split("?")[0] ?? path);

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
