/**
 * In-memory auth session for one MCP connection (stdio process or HTTP session).
 * Priority for user Bearer: session token (login tools) > EREBRUS_BEARER_TOKEN env.
 */

export type SessionAuthSource = "wallet" | "email" | "import" | "env" | "none";

export interface SessionSnapshot {
  authenticated: boolean;
  source: SessionAuthSource;
  user_id?: string;
  role?: string;
  has_session_token: boolean;
  has_env_bearer_fallback: boolean;
  has_api_key: boolean;
  token_preview?: string;
}

export class SessionStore {
  private sessionToken?: string;
  private userId?: string;
  private role?: string;
  private source: SessionAuthSource = "none";

  constructor(
    private readonly envBearer?: string,
    private readonly envApiKey?: string,
  ) {}

  /** Active user PASETO: session first, then env fallback. */
  getBearer(): string | undefined {
    return this.sessionToken ?? empty(this.envBearer);
  }

  getApiKey(): string | undefined {
    return empty(this.envApiKey);
  }

  setSession(token: string, meta?: { userId?: string; role?: string; source: SessionAuthSource }): void {
    this.sessionToken = token.trim();
    this.userId = meta?.userId;
    this.role = meta?.role;
    this.source = meta?.source ?? "import";
  }

  clearSession(): void {
    this.sessionToken = undefined;
    this.userId = undefined;
    this.role = undefined;
    this.source = "none";
  }

  snapshot(): SessionSnapshot {
    const bearer = this.getBearer();
    const hasSession = Boolean(this.sessionToken);
    const hasEnv = Boolean(empty(this.envBearer));
    let source: SessionAuthSource = this.source;
    if (!hasSession && hasEnv) source = "env";
    if (!bearer) source = "none";

    return {
      authenticated: Boolean(bearer),
      source,
      user_id: this.userId,
      role: this.role,
      has_session_token: hasSession,
      has_env_bearer_fallback: hasEnv,
      has_api_key: Boolean(empty(this.envApiKey)),
      token_preview: bearer ? previewToken(bearer) : undefined,
    };
  }
}

function empty(v?: string): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function previewToken(t: string): string {
  if (t.length <= 16) return "***";
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}
