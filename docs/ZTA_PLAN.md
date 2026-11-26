# Zero-Trust Architecture — MCP work order (`feat/zta-plan`)

Companion work orders on the same branch name:
`erebrus-gateway/docs/ZTA_PLAN.md`, `erebrus/docs/ZTA_PLAN.md`,
`erebrus-vpn/docs/ZTA_HANDOVER.md`. Master narrative:
`erebrus-vpn/docs/ZERO_TRUST_PLAN.md`.

This repo owns **T6 (agent egress)**, plus the agent-facing slices of
**T7 (USDC subscriptions)**, **T5 (on-chain verification)** and
**T2 (two-hop)**. Written against `erebrus-mcp@b9cf782` (v0.2.0).

## The gap

Today this server is **control plane only**. It can authenticate an agent, create
an org, mint an API key, register a node, provision a VPN client
(`vpn_client_create`) and hand back a config (`vpn_client_get_config`) — and then
it stops. The agent is expected to bring its own WireGuard, which no agent has.
So the current tool surface gets an agent *an account*, not *an egress*.

Closing that is the whole track: the MCP server should run the tunnel itself and
expose it to the agent as something an agent can already use — a proxy, or a
fetch tool.

## What this does and does not hide — be precise in the README

- **Hidden from the destination**: the agent's IP. The site sees the Erebrus
  node's egress IP, in the region the agent asked for. This is what unlocks
  geofenced and IP-blocked content.
- **Not hidden from the node operator** by default: the node sees the MCP host's
  IP, because that host dials it. Two-hop (T2) is what closes that, which is why
  `vpn_egress_start` takes a `two_hop` flag from day one.
- **Not hidden from the local machine**: this is a local process. Anything with
  root on the agent host sees everything.

Do not let the README say "complete anonymity". Say which observer sees what.

---

## 1. Egress runtime (`src/egress/`)

New module, four files, no framework:

| File | Job |
| --- | --- |
| `binary.ts` | Locate/fetch the sing-box binary, verify checksum |
| `config.ts` | Build a proxy-mode sing-box config from a credential bundle |
| `supervisor.ts` | Spawn, health-check, restart, and reliably kill the process |
| `registry.ts` | Track live egress sessions (id → port, node, bundle, started_at) |

### `config.ts` — do not reinvent the config

`erebrus-vpn`'s `SingboxConfigBuilder.build(..., useSystemTunnel: false)` already
emits exactly what is needed: no TUN, a `mixed` inbound on `127.0.0.1:10808`
(HTTP + SOCKS on one port), the WireGuard endpoint, and the stealth carriers when
the bundle has them. Port that shape — the bundle from `vpn_client_get_config`
already contains `singbox_profile`, so most of the work is substituting the
client private key and the inbound.

Treat `erebrus-vpn/test/vpn_config_test.dart` as the shared contract. **If this
TypeScript copy drifts from the Dart one, the symptom is an agent silently
leaking its own IP**, which is the exact failure the feature exists to prevent.
Mirror the two-hop endpoint graph (`wg-exit` with `detour: wg-entry`, bypass on
the entry host only, MTU 1280/1200) rather than inventing a second design.

### WireGuard keys without a dependency

Node has x25519 built in — `crypto.generateKeyPairSync('x25519')`. WireGuard
wants the raw 32-byte scalars base64'd, not DER/PEM, so export as JWK and convert
`d` / `x` from base64url. That is the one fiddly part; write it once in
`binary.ts`'s neighbour `keys.ts` with a test vector, and never log either half —
extend `src/util/redact.ts` to cover `private_key` and `wg_private_key`.

### The sing-box binary

Pin a version and a per-platform SHA-256. Resolution order: explicit path →
cached download under the OS cache dir → fail with a clear instruction.
`Dockerfile` and `docker-compose.yml` already exist here; bake the binary into
the image so the hosted path never downloads at runtime.

### Supervisor rules that matter

- **Bind the egress to loopback only.** Note that `config.ts` in this repo
  defaults `httpHost` to `0.0.0.0` for the MCP HTTP transport — the egress proxy
  must **not** copy that default. A proxy on `0.0.0.0` is an open relay for the
  agent host's whole LAN, and it will be found.
- Kill the child on parent exit, including stdio parent death and SIGINT/SIGTERM.
  Track the pid in `registry.ts` and sweep orphans on startup; a sing-box left
  running after the agent disconnects is both a leak and a support ticket.
- Allocate ports dynamically from an ephemeral range; never assume 10808 is free,
  since the user may also be running the desktop app.
- Cap concurrent egress sessions (default 2) so a confused agent cannot fork-bomb
  tunnels.

---

## 2. Tools

Naming follows the existing convention (snake_case, domain prefix).

### Egress

| Tool | Notes |
| --- | --- |
| `vpn_egress_start` | `{ region? , node_id?, two_hop?, exit_region? }` → `{ session_id, proxy_url, node, egress_ip, region }`. Provisions the client(s) itself; the agent never touches a config. |
| `vpn_egress_status` | `{ session_id? }` → live sessions, uptime, bytes, current egress IP |
| `vpn_egress_stop` | `{ session_id }` → tears down and deletes the provisioned client |
| `erebrus_fetch` | `{ url, method?, headers?, body?, region?, session_id? }` → performs the request through the tunnel and returns status/headers/body |
| `vpn_regions_list` | regions + node counts, from the new gateway `GET /api/v2/regions` |

`vpn_egress_start` should **verify before returning**: fetch the egress IP
through the new proxy and include it in the result. An agent that gets a
`proxy_url` back has no other way to know the tunnel actually carries traffic,
and a silently-dead proxy that falls back to direct is the worst outcome here.

`erebrus_fetch` is the mode most agents will use, because it needs zero agent
configuration. It is also where the subtle leak lives — see §3.

### Payments (T7)

| Tool | Notes |
| --- | --- |
| `billing_crypto_intent_create` | `{ org_id, plan_id, billing_interval, chain }`, chain is `evm \| sol` → address, USDC token, amount, reference, expiry. Agent signs and pays from its own wallet. |
| `billing_crypto_intent_status` | `{ org_id, intent_id }` → `pending \| confirming \| settled \| expired \| underpaid` |
| `org_entitlements` | exists already — surfaces the result |

This is the loop that makes an agent self-sufficient: authenticate with a wallet,
create an org, pay in USDC, start an egress — no human. USDC is the only accepted
asset on either chain, which is what keeps the tool schema this small: no asset
argument, no quote to refresh, no expiry-means-reprice handling. The amount in
the intent is final; a late payment is still correct. It depends on the gateway
accepting an **org API key** (not only a user bearer) on the intent endpoint; if
that lands bearer-only, the agent still needs a human-issued token and the loop
is broken. Flag it early with the gateway work.

### Node trust (T5)

`nodes_directory` gains `onchain_registered` and `org_verified` passthrough, and
an optional `verified_only` filter. An agent choosing an exit node should be able
to prefer nodes whose identity is attested on chain.

### Path allowlist

`assertPathAllowed` in `src/client/gateway.ts` will reject every new endpoint
until `ALLOWED_PREFIXES` is updated: `/api/v2/regions`,
`/api/v2/orgs/*/billing/crypto`, `/api/v2/bootstrap`. Easy to forget; the symptom
is a confusing 403 from our own client rather than from the gateway.

---

## 3. The leak to get right: DNS in fetch mode

Node's `fetch` resolves the hostname **locally** before dialling, so a naive
proxy wiring sends the agent's resolver every hostname it visits — the censor or
the corporate resolver still sees exactly where the agent went, while the agent
believes it is tunnelled.

- Use an HTTP `CONNECT` proxy (the `mixed` inbound speaks it) or SOCKS5**h**, so
  the *hostname* goes to the proxy and resolution happens inside the tunnel.
- With `undici`'s `ProxyAgent`, confirm no pre-resolution happens on the path
  taken; assert it in a test rather than by reading docs.
- Add a regression test: resolve a hostname that only the node's resolver can
  answer, and fail if the local resolver was consulted.

Same discipline applies to IPv6 and to any `Host`-header rewriting.

---

## 4. Abuse control

Agent egress attracts scraping, credential stuffing and fraud. The quota and
revocation work lives in the gateway (`org_entitlements.egress_gb_month`,
`egress_clients_max`, `internal/store/access_revocation.go`), but this repo must:

- surface those error codes as actionable tool errors rather than a bare 403,
- delete the provisioned client on `vpn_egress_stop` **and** on process exit, so
  an abandoned agent does not hold a peer slot forever,
- send `X-Erebrus-Client: mcp` on every request so agent traffic is separable in
  gateway metrics from day one.

Ship these with the feature, not after it.

---

## 5. Testing

This repo has no test runner today (`package.json` has `typecheck` and `build`
only). Add `node --test` — no new framework, no new dependency:

- `test/egress_config.test.ts` — single-hop and two-hop configs match the Dart
  contract: endpoint graph, detour chain, exactly one direct bypass, MTU ladder.
- `test/keys.test.ts` — x25519 raw-key conversion against a known vector.
- `test/supervisor.test.ts` — child is killed on parent exit; orphan sweep works.
- `test/fetch_dns.test.ts` — the DNS-leak regression above.
- `test/allowlist.test.ts` — every path the new tools use passes
  `assertPathAllowed`.

## 6. Config additions

The other three repos hold a strict no-new-env-var rule because they are deployed
services whose operators should not have to re-learn a config surface. This repo
is a CLI/agent tool configured entirely by env, so that rule does not transfer —
but keep additions minimal. Two are justified:

- `EREBRUS_SINGBOX_PATH` — explicit binary location for packaged installs.
- `EREBRUS_EGRESS_MAX_SESSIONS` — the concurrency cap above.

Everything else (ports, regions, two-hop) belongs in tool arguments, where the
agent can decide per call.

---

## Order of work

1. `src/egress/` — binary, keys, config, supervisor, with `vpn_egress_start` /
   `status` / `stop` and egress-IP verification.
2. `erebrus_fetch` plus the DNS-leak test. This is the tool most agents use.
3. `vpn_regions_list` and `nodes_directory` verification passthrough.
4. `two_hop` support, once T2 lands in the Dart builder worth mirroring.
5. Crypto payment tools, once the gateway intent endpoints exist.
6. README rewrite — the observer table at the top of this document is the part
   that must not be overstated.
