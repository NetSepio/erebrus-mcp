# Changelog

## Unreleased — agent egress

### TL;DR

- An agent can now get an actual egress, not just an account:
  `vpn_egress_start` provisions a client, runs the tunnel here and hands back a
  loopback proxy URL — verified by reading the egress IP through it first.
- `vpn_egress_stop` deletes the provisioned client as well as killing the
  tunnel, and the same cleanup runs if this process exits or is killed.
- `vpn_regions_list` says where an egress can come out.

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
