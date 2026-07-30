# erebrus-mcp

MCP server so **agents** can onboard onto [Erebrus](https://erebrus.io): authenticate (wallet or email), create orgs, mint API keys and node registration tokens, install nodes, provision VPN clients, and use Drop — against the public gateway API.

**Not exposed:** admin, leaderboard/rank/perks/social, deep firewall rule editing, billing webhooks.

## Auth model

Agents **should log in via tools**, not a pre-shared secret:

| Flow | Tools |
|------|--------|
| Wallet | `auth_wallet_challenge` → sign message → `auth_wallet_complete` |
| Email OTP | `auth_email_login_start` → read code → `auth_email_login_verify` |
| Import | `auth_import_token` (existing PASETO) |
| Status | `auth_status`, `auth_methods`, `auth_logout` |

Successful login stores a **user PASETO in the MCP session**.  
`EREBRUS_BEARER_TOKEN` is an **optional env fallback** for operators/CI only.

| Credential | Env | Use |
|------------|-----|-----|
| Session PASETO | (from auth tools) | Orgs, keys, node tokens, VPN, Drop |
| Env PASETO | `EREBRUS_BEARER_TOKEN` | Fallback if no session login |
| Org API key | `EREBRUS_API_KEY` | `/api/v2/org/*` only (VPN clients + usage) today |
| Default org | `EREBRUS_DEFAULT_ORG_ID` | Optional default `org_id` |

## Tool map

### Session / health
`gateway_health`, `whoami`, `auth_*`

### Orgs & keys
`org_create`, `org_list`, `org_get`, `org_entitlements`, `apikey_create`, `apikey_list`, `apikey_revoke`

### Nodes
`node_registration_token_create`, `org_nodes_list`, `org_node_get`, `operator_nodes_list`, `nodes_directory`, `node_install_plan`

### VPN
`vpn_client_list`, `vpn_client_create`, `vpn_client_get_config`, `vpn_client_delete`, `org_vpn_client_create`, `org_vpn_client_list`, `org_usage`

### Drop
`drop_nodes_list`, `drop_upload_reserve`, `drop_upload_content`, `drop_upload_status`, `drop_files_list`, `drop_file_get`, `drop_file_delete`, `drop_usage`, `org_drop_files`, `org_drop_usage`

## Suggested agent flow

1. `auth_methods` / `auth_wallet_challenge` (or email login)
2. `whoami` → `org_create` / `org_list`
3. `apikey_create` (store secret offline)
4. `node_registration_token_create` → `node_install_plan` → run on host
5. `vpn_client_create` + `vpn_client_get_config`
6. Drop: `drop_nodes_list` → reserve → upload content

## Develop

```bash
npm install
npm run typecheck
npm run build
npm run dev        # stdio
npm run dev:http   # http://0.0.0.0:3100/mcp
```

## Grok / Cursor (stdio)

```toml
[mcp_servers.erebrus]
command = "node"
args = ["/absolute/path/to/erebrus-mcp/dist/index.js"]
env = { EREBRUS_GATEWAY_URL = "https://gateway.erebrus.io" }
```

Agents log in with tools; no token required in env for interactive use.

## Hosted HTTP

```bash
MCP_AUTH_TOKEN=change-me npm run start:http
# or
docker compose up --build
```

- MCP endpoint: `POST/GET/DELETE /mcp`
- Health: `GET /healthz`
- Set `MCP_AUTH_TOKEN` in production (client sends `Authorization: Bearer …`)
- Each MCP session has its own auth session store

```toml
[mcp_servers.erebrus_http]
url = "https://mcp.example.com/mcp"
headers = { Authorization = "Bearer change-me" }
```

## Security

- HTTP client path allowlist blocks admin/rank/social/firewall-rules/referrals.
- One-time secrets (`api_key`, `ere_reg_*`, PASETO) — store offline; avoid chat logs.
- Wallet signing is **outside** this server (agent/host wallet or human).
- Drop upload via MCP is capped at ~15MB base64 payload.

## License

MIT (see `LICENSE`).
