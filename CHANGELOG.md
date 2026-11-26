# Changelog

## Unreleased — agent egress

### TL;DR

- An agent can now get an actual egress, not just an account:
  `vpn_egress_start` provisions a client, runs the tunnel here and hands back a
  loopback proxy URL — verified by reading the egress IP through it first.
- `vpn_egress_stop` deletes the provisioned client as well as killing the
  tunnel, and the same cleanup runs if this process exits or is killed.
- `vpn_regions_list` says where an egress can come out.
- Both dependencies are current, nine advisories are gone, and CI runs the
  tests and blocks on a high or critical one.

### Added

- **`src/egress/`** — the runtime behind those tools:
  - `keys.ts` — WireGuard X25519 keys with no dependency, pinned to the
    RFC 7748 §6.1 vector. WireGuard wants raw 32-byte scalars in standard
    base64 and Node exports DER, PEM or JWK base64url, which is the kind of
    mismatch that yields a key the node accepts and a tunnel that never carries
    a packet.
  - `config.ts` — the proxy-mode sing-box config, ported from the Flutter
    client's `SingboxConfigBuilder.build(..., useSystemTunnel: false)`. Two
    implementations of one config is a real risk — a drifted copy leaks the
    agent's own IP, the exact failure this feature exists to prevent — so
    `test/egress_config.test.ts` holds this one to the same contract the Dart
    test asserts: endpoint graph, DNS graph, exactly one direct bypass, MTU,
    loopback-only inbound, no TUN.
  - `supervisor.ts` — spawns sing-box, waits until the proxy actually accepts a
    connection, and kills the child on parent exit, SIGINT, SIGTERM and SIGHUP.
    Ports come from the OS, never a fixed 10808, which the desktop app may be
    using.
  - `registry.ts` — live sessions, the concurrency cap, and an orphan sweep for
    a sing-box left by a previous run. A recorded pid is checked against its
    command line before anything is killed: pids are recycled, and killing a
    stranger's process is worse than leaving a tunnel up.
  - `binary.ts` — finds sing-box (explicit path, cache dir, PATH) and otherwise
    fails with the three ways to fix it. It does not download: an unverified
    binary that proxies all of an agent's traffic is worse than an error, and
    the Docker image already ships one.
  - `probe.ts` — one HTTPS GET through the proxy over HTTP `CONNECT`, which is
    how the hostname reaches the tunnel instead of the agent's own resolver.
- **`vpn_regions_list`** from the gateway's new `GET /api/v2/regions`.
- **Tests** — `node --test` with no new dependency: keys against the RFC
  vector, the config contract, the supervisor's readiness and cleanup, the
  session cap and orphan sweep, and the path allowlist.

### Changed

- Every gateway request carries `X-Erebrus-Client: mcp`, so agent traffic is
  separable in gateway metrics from the first request rather than after the
  first abuse report.
- The path allowlist admits `/api/v2/regions` and `/api/v2/bootstrap`. Missing
  entries fail as a 403 from this client, which reads exactly like a gateway
  permission problem and sends the reader the wrong way.
- README documents the egress tools with an observer table: the destination
  sees the node's IP, the node operator sees this host's IP, and anything with
  root on this machine sees everything. It is not anonymity and the README does
  not say it is.

### Security

- **Both production dependencies moved up, clearing nine advisories.**
  `@modelcontextprotocol/sdk` ^1.30.0 -> ^1.32.2 and `zod` ^3.25 -> ^4.6.7.
  Eight of the nine arrived through the SDK — one critical (`proxy-addr` trusting
  IPv4-mapped IPv6 addresses), three more high ones (the SDK's own OAuth client
  could send credentials to a server the authorization flow chose, experimental
  tasks were not tied to the session that created them, `body-parser` and
  `fast-uri`), and four moderate (`hono`, `@hono/node-server`, `ip-address`,
  `qs`). The zod advisory needed the major bump, because every 3.x release can
  be made to exhaust memory on an oversized collection; the SDK accepts
  `^3.25 || ^4.0`, so there is still one deduplicated copy in the tree.
  The migration needed no code change: all 44 tools still publish object
  schemas, and `minLength`, `enum`, `format: email` and the integer bounds all
  survive into the generated JSON Schema.
- **CI runs the tests and fails on a high or critical advisory.** The workflow
  typechecked, built and smoke-imported the server but never ran `npm test`, so
  the suite was only ever green on whoever's machine last ran it. It now runs
  the tests and `npm audit --omit=dev --audit-level=high`. Moderate findings
  stay visible in the log rather than blocking, since npm audit has no
  reachability analysis and would otherwise fail unrelated pull requests.

### Not yet

- `two_hop` is accepted by `vpn_egress_start` and refused with a reason: it
  mirrors the client's two-hop endpoint graph, which lands with T2 in
  erebrus-vpn. A guessed copy would silently degrade to single-hop, with no
  visible symptom.
- `erebrus_fetch` (the tool most agents will reach for) and the USDC payment
  tools are next, in that order.
- Byte counters in `vpn_egress_status` need sing-box's Clash API, which means
  another loopback listener; left out until that is worth its surface.
- An org API key cannot start an egress: the gateway serves the client config
  only on the user route, so an agent with `X-Api-Key` alone cannot fetch a
  credential bundle. That is a gateway gap, flagged for the gateway work.
