/**
 * Runtime configuration from environment.
 *
 * Auth notes (gateway reality today):
 * - User management routes (/api/v2/orgs, /apikeys, node-registration-tokens, …)
 *   require Authorization: Bearer <user PASETO>.
 * - X-Api-Key only unlocks /api/v2/org/* (VPN clients + usage) — not org create/keys/tokens.
 */

export type AuthMode = "bearer" | "api_key" | "none";

export interface Config {
  gatewayUrl: string;
  bearerToken?: string;
  apiKey?: string;
  defaultOrgId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayUrl = (env.EREBRUS_GATEWAY_URL ?? "https://gateway.erebrus.io").replace(
    /\/+$/,
    "",
  );
  const bearerToken = emptyToUndef(env.EREBRUS_BEARER_TOKEN ?? env.EREBRUS_TOKEN);
  const apiKey = emptyToUndef(env.EREBRUS_API_KEY);
  const defaultOrgId = emptyToUndef(env.EREBRUS_DEFAULT_ORG_ID);

  return { gatewayUrl, bearerToken, apiKey, defaultOrgId };
}

function emptyToUndef(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

export function describeAuth(cfg: Config): {
  mode: AuthMode;
  has_bearer: boolean;
  has_api_key: boolean;
  default_org_id?: string;
  note: string;
} {
  const has_bearer = Boolean(cfg.bearerToken);
  const has_api_key = Boolean(cfg.apiKey);
  let mode: AuthMode = "none";
  if (has_bearer) mode = "bearer";
  else if (has_api_key) mode = "api_key";

  let note: string;
  if (mode === "bearer") {
    note =
      "User PASETO configured — full agent onboarding tools (orgs, API keys, node tokens) available.";
  } else if (mode === "api_key") {
    note =
      "Only org API key set. Gateway currently allows X-Api-Key on /api/v2/org/* (VPN/usage) only. " +
      "Set EREBRUS_BEARER_TOKEN for org/API-key/node-token management.";
  } else {
    note =
      "No credentials. Public tools only (gateway_health, nodes_directory). " +
      "Set EREBRUS_BEARER_TOKEN for management tools.";
  }

  return {
    mode,
    has_bearer,
    has_api_key,
    default_org_id: cfg.defaultOrgId,
    note,
  };
}
