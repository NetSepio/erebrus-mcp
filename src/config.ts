/**
 * Runtime configuration from environment.
 *
 * User management routes need a user PASETO (session login tools or EREBRUS_BEARER_TOKEN).
 * Org X-Api-Key only unlocks /api/v2/org/* (VPN clients + usage) today.
 */

export interface Config {
  gatewayUrl: string;
  bearerToken?: string;
  apiKey?: string;
  defaultOrgId?: string;
  /** HTTP listen port when transport=http */
  httpPort: number;
  /** Bind address for HTTP */
  httpHost: string;
  /** Optional shared secret for hosted MCP (Authorization: Bearer <this>) */
  mcpAuthToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayUrl = (env.EREBRUS_GATEWAY_URL ?? "https://gateway.erebrus.io").replace(/\/+$/, "");
  return {
    gatewayUrl,
    bearerToken: emptyToUndef(env.EREBRUS_BEARER_TOKEN ?? env.EREBRUS_TOKEN),
    apiKey: emptyToUndef(env.EREBRUS_API_KEY),
    defaultOrgId: emptyToUndef(env.EREBRUS_DEFAULT_ORG_ID),
    httpPort: Number(env.MCP_PORT ?? env.PORT ?? 3100) || 3100,
    httpHost: env.MCP_HOST ?? "0.0.0.0",
    mcpAuthToken: emptyToUndef(env.MCP_AUTH_TOKEN),
  };
}

function emptyToUndef(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}
