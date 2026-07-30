# erebrus-mcp

MCP server so **agents** can onboard onto [Erebrus](https://erebrus.io): authenticate (wallet or email), create orgs, mint API keys and node registration tokens, run nodes (via install plan + registration token), provision VPN clients, and use Drop — against the public gateway API.

**Supported transport: stdio only** (spawned by Grok, Cursor, Claude Code, etc.).  
HTTP transport code may exist in-tree for experiments; it is **not** the supported agent path for v0.2.

**Not exposed:** admin, leaderboard/rank/perks/social, deep firewall rule editing, billing webhooks.

## Quick start (stdio)

```bash
# from npm (after publish)
npx -y @netsepio/erebrus-mcp

# from clone
npm install && npm run build && node dist/index.js
```

### Grok

```toml
# ~/.grok/config.toml
[mcp_servers.erebrus]
command = "npx"
args = ["-y", "@netsepio/erebrus-mcp"]
env = { EREBRUS_GATEWAY_URL = "https://gateway.erebrus.io" }
```

Or pin a local build:

```toml
[mcp_servers.erebrus]
command = "node"
args = ["/absolute/path/to/erebrus-mcp/dist/index.js"]
env = { EREBRUS_GATEWAY_URL = "https://gateway.erebrus.io" }
```

### Cursor / Claude Code

```json
{
  "mcpServers": {
    "erebrus": {
      "command": "npx",
      "args": ["-y", "@netsepio/erebrus-mcp"],
      "env": {
        "EREBRUS_GATEWAY_URL": "https://gateway.erebrus.io"
      }
    }
  }
}
```

Agents authenticate with tools (wallet or email). No env token required for interactive use.

Optional env (see [`.env.example`](./.env.example)):

| Env | Use |
|-----|-----|
| `EREBRUS_GATEWAY_URL` | Gateway base (default `https://gateway.erebrus.io`) |
| `EREBRUS_BEARER_TOKEN` | Optional pre-seeded user PASETO (CI/operators only) |
| `EREBRUS_API_KEY` | Org API key — today only `/api/v2/org/*` (VPN clients + usage) |
| `EREBRUS_DEFAULT_ORG_ID` | Default `org_id` when tools omit it |

## Auth model

Agents **log in via tools**, not a pre-shared MCP secret:

| Flow | Tools |
|------|--------|
| Wallet | `auth_wallet_challenge` → sign message → `auth_wallet_complete` |
| Email OTP | `auth_email_login_start` → read code → `auth_email_login_verify` |
| Import | `auth_import_token` (existing PASETO) |
| Status | `auth_status`, `auth_methods`, `auth_logout` |

Successful login stores a **user PASETO in the MCP session** for that process.  
`EREBRUS_BEARER_TOKEN` is an **optional env fallback** only.

| Credential | Source | Use |
|------------|--------|-----|
| Session PASETO | auth tools | Orgs, keys, node tokens, VPN, Drop |
| Env PASETO | `EREBRUS_BEARER_TOKEN` | Fallback if no session login |
| Org API key | `EREBRUS_API_KEY` | `/api/v2/org/*` only (VPN/usage) until gateway expands scopes |

**Agent responsibilities outside MCP:** wallet signing or reading email OTP; choosing a VPS and running the install command from `node_install_plan` with the registration token.

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

1. `auth_methods` → wallet or email login tools  
2. `whoami` → `org_create` / `org_list`  
3. Optional `apikey_create` (store secret offline)  
4. `node_registration_token_create` → `node_install_plan` → run installer on the agent’s chosen VPS  
5. `vpn_client_create` + `vpn_client_get_config`  
6. Drop: `drop_nodes_list` → reserve → upload content  

## Develop

```bash
npm install
npm run typecheck
npm run build
npm run dev        # stdio (supported)
```

Requirements: Node.js ≥ 20.

## Docker image

CI publishes `ghcr.io/netsepio/erebrus-mcp` for packaging. **stdio** is still the agent integration mode — run interactively and attach stdin/stdout:

```bash
docker pull ghcr.io/netsepio/erebrus-mcp:latest
docker run --rm -i \
  -e EREBRUS_GATEWAY_URL=https://gateway.erebrus.io \
  ghcr.io/netsepio/erebrus-mcp:latest
```

Point an MCP client’s `command`/`args` at a wrapper that runs the same image with `-i` if you prefer container isolation over `npx`.

## Security

- HTTP client path allowlist blocks admin/rank/social/firewall-rules/referrals.  
- One-time secrets (`api_key`, `ere_reg_*`, PASETO) — store offline; avoid chat logs.  
- Drop upload via MCP is capped at ~15MB base64 payload.  
- Do not commit `.env` or long-lived tokens.  

## CI

- **CI** — typecheck + build on push/PR to `main`  
- **Docker** — build/push `ghcr.io/netsepio/erebrus-mcp` on `main` and version tags  
- **npm** — publish `@netsepio/erebrus-mcp` on `v*` tags when `NPM_TOKEN` is set  

## License

MIT (see [`LICENSE`](./LICENSE)).
