# erebrus-mcp

MCP server so agents can onboard onto [Erebrus](https://erebrus.io): create orgs, mint API keys and node registration tokens, and get a node install runbook — against the public gateway API.

**Phase 0–1 (this release):** stdio transport, health/profile, orgs, API keys, node tokens, node lists, install plan.

**Not exposed (by design):** admin, leaderboard/rank/perks/social, deep firewall rule editing, billing webhooks.

## Auth model

| Credential | Env | Gateway use |
|------------|-----|-------------|
| User PASETO | `EREBRUS_BEARER_TOKEN` | **Required** for orgs, API keys, node registration tokens, org nodes, profile |
| Org API key | `EREBRUS_API_KEY` | Today only `/api/v2/org/*` (VPN clients + usage) — optional for Phase 1 |
| Default org | `EREBRUS_DEFAULT_ORG_ID` | Optional default for tools that take `org_id` |

```bash
export EREBRUS_GATEWAY_URL=https://gateway.erebrus.io
export EREBRUS_BEARER_TOKEN='…'   # from wallet/social login
```

## Tools

| Tool | Auth | Purpose |
|------|------|---------|
| `gateway_health` | none | `/healthz`, `/readyz`, `/version` |
| `whoami` | bearer | Account profile + auth status |
| `org_create` / `org_list` / `org_get` / `org_entitlements` | bearer | Organizations |
| `apikey_create` / `apikey_list` / `apikey_revoke` | bearer | Org API keys (`api_key` shown **once**) |
| `node_registration_token_create` | bearer | Mint `ere_reg_*` (**once**) |
| `org_nodes_list` / `org_node_get` | bearer | Org control-plane nodes |
| `operator_nodes_list` | bearer | Runtime nodes for member orgs |
| `nodes_directory` | none | Public node directory |
| `node_install_plan` | none* | Install command + ports (*needs token string you already have) |

Suggested agent flow:

1. `whoami`
2. `org_create` → save `org_id`
3. `apikey_create` → store secret offline
4. `node_registration_token_create` → `node_install_plan` → run on host
5. `org_nodes_list` to verify

## Develop

```bash
npm install
npm run typecheck
npm run build
npm run dev   # stdio server via tsx
```

## Grok / Cursor (stdio)

```toml
# ~/.grok/config.toml
[mcp_servers.erebrus]
command = "node"
args = ["/absolute/path/to/erebrus-mcp/dist/index.js"]
env = {
  EREBRUS_GATEWAY_URL = "https://gateway.erebrus.io",
  EREBRUS_BEARER_TOKEN = "…",
  EREBRUS_DEFAULT_ORG_ID = "…",
}
```

Or during development:

```toml
[mcp_servers.erebrus]
command = "npx"
args = ["tsx", "/absolute/path/to/erebrus-mcp/src/index.ts"]
env = { EREBRUS_BEARER_TOKEN = "…" }
```

## Security

- Path allowlist in the HTTP client blocks `/admin`, `/rank`, `/leaderboard`, `/perks`, `/social`, `/referrals`, firewall rules.
- Do not commit `.env` or paste long-lived tokens into prompts.
- Treat `api_key` and `ere_reg_*` as one-time secrets.

## Roadmap

- Phase 2: VPN client create/config tools  
- Phase 3: Drop list/upload/usage  
- Phase 4: Streamable HTTP transport + Docker for hosted MCP  
- Gateway follow-up: expand org API key scopes so agents can avoid user PASETO for node tokens  

## License

MIT (see `LICENSE`).
