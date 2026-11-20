import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEgressConfig,
  MIXED_INBOUND_TAG,
  PROXY_HOST,
  WG_TAG,
  interfacePrefixes,
  splitHostPort,
} from "../src/egress/config.js";

/**
 * The shared contract with `erebrus-vpn/test/vpn_config_test.dart`. Two
 * implementations of one config is the risk this file exists to contain: if
 * this copy drifts, the symptom is an agent that silently leaks its own IP.
 */
const bundle = {
  wireguard: {
    server_public_key: "c2VydmVyLXB1YmxpYy1rZXktMzItYnl0ZXMtbG9uZy0h",
    endpoint: "node.example.com:51820",
    address: "100.64.0.8/32, fd00:64:64::8/128",
    dns: "10.0.0.53",
  },
};

function config(extra: Record<string, unknown> = {}) {
  return buildEgressConfig({
    bundle,
    clientPrivateKey: "Y2xpZW50LXByaXZhdGUta2V5LTMyLWJ5dGVzLWxvbmch",
    proxyPort: 41234,
    ...extra,
  }) as Record<string, any>;
}

test("binds one loopback mixed inbound and no TUN", () => {
  const c = config();
  assert.equal(c.inbounds.length, 1);
  const inbound = c.inbounds[0];
  assert.equal(inbound.type, "mixed");
  assert.equal(inbound.tag, MIXED_INBOUND_TAG);
  // A proxy on 0.0.0.0 is an open relay for the agent host's whole LAN.
  assert.equal(inbound.listen, PROXY_HOST);
  assert.equal(inbound.listen_port, 41234);
  assert.ok(!c.inbounds.some((i: any) => i.type === "tun"), "an agent process must not hold a TUN");
});

test("routes everything into the WireGuard endpoint", () => {
  const c = config();
  assert.equal(c.route.final, WG_TAG);
  assert.equal(c.endpoints.length, 1);
  const wg = c.endpoints[0];
  assert.equal(wg.tag, WG_TAG);
  assert.equal(wg.mtu, 1280);
  assert.deepEqual(wg.address, ["100.64.0.8/32", "fd00:64:64::8/128"]);
  assert.equal(wg.peers[0].address, "node.example.com");
  assert.equal(wg.peers[0].port, 51820);
  assert.deepEqual(wg.peers[0].allowed_ips, ["0.0.0.0/0", "::/0"]);
  assert.equal(wg.peers[0].persistent_keepalive_interval, 25);
});

test("exactly one direct bypass, for the peer the tunnel dials", () => {
  const c = config();
  const bypasses = c.route.rules.filter((r: any) => r.outbound === "direct" && !r.ip_cidr?.includes("127.0.0.0/8"));
  assert.equal(bypasses.length, 1, "a second bypass is how traffic escapes the tunnel");
  assert.deepEqual(bypasses[0].domain, ["node.example.com"]);
  // The bypass has to come before the catch-all, or the handshake is routed
  // into the tunnel it is trying to build.
  assert.equal(c.route.rules[0], bypasses[0]);
  assert.equal(c.route.rules[1].action, "hijack-dns");
});

test("a pre-resolved peer is dialled as a literal and needs no DNS rule", () => {
  const c = config({ peerAddress: "203.0.113.9" });
  assert.equal(c.endpoints[0].peers[0].address, "203.0.113.9");
  assert.deepEqual(c.route.rules[0], { ip_cidr: ["203.0.113.9/32"], outbound: "direct" });
  assert.equal(c.dns.rules, undefined);
});

test("DNS resolves inside the tunnel, with the peer hostname bootstrapped outside", () => {
  const c = config();
  assert.equal(c.dns.final, "dns-remote");
  assert.equal(c.dns.strategy, "prefer_ipv4");
  const remote = c.dns.servers.find((s: any) => s.tag === "dns-remote");
  assert.equal(remote.address, "10.0.0.53");
  assert.equal(remote.detour, WG_TAG);
  const direct = c.dns.servers.find((s: any) => s.tag === "dns-direct");
  assert.equal(direct.detour, "direct");
  assert.deepEqual(c.dns.rules, [{ domain: ["node.example.com"], server: "dns-direct" }]);
});

test("refuses a bundle or a port it cannot build from", () => {
  assert.throws(() => buildEgressConfig({ bundle: {}, clientPrivateKey: "k", proxyPort: 1 }), /wireguard/);
  assert.throws(() => config({ proxyPort: 0 }), /port/);
  assert.throws(() => config({ proxyPort: 70000 }), /port/);
  assert.throws(
    () => buildEgressConfig({ bundle, clientPrivateKey: "  ", proxyPort: 1080 }),
    /private key/,
  );
});

test("parses the address and endpoint shapes nodes actually send", () => {
  assert.deepEqual(interfacePrefixes("100.64.0.8"), ["100.64.0.8/32"]);
  assert.deepEqual(interfacePrefixes("fd00::8"), ["fd00::8/128"]);
  assert.deepEqual(interfacePrefixes(" 10.0.0.2/32 , "), ["10.0.0.2/32"]);
  assert.deepEqual(splitHostPort("node.example.com:51820"), ["node.example.com", 51820]);
  assert.deepEqual(splitHostPort("[2001:db8::1]:51820"), ["2001:db8::1", 51820]);
  assert.deepEqual(splitHostPort("node.example.com"), ["node.example.com", 51820]);
});
