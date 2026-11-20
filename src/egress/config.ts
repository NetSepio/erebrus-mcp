/**
 * Proxy-mode sing-box config for an agent egress.
 *
 * This is a port of `SingboxConfigBuilder.build(..., useSystemTunnel: false)` in
 * erebrus-vpn (`lib/vpn/vpn_models.dart`), and `test/egress_config.test.ts`
 * holds it to the same contract as `erebrus-vpn/test/vpn_config_test.dart`.
 * The two implementations existing at all is a risk worth naming: if this one
 * drifts, the symptom is an agent that silently leaks its own IP, which is the
 * exact failure the feature exists to prevent. So the tags, the route rule
 * order and the DNS graph below are copied rather than reinvented.
 */

/** Credential bundle as `vpn_client_get_config` returns it. */
export interface CredentialBundle {
  wireguard?: {
    server_public_key?: string;
    endpoint?: string;
    address?: string;
    dns?: string;
  };
  singbox_profile?: Record<string, unknown>;
}

export interface EgressConfigOptions {
  bundle: CredentialBundle;
  /** base64 WireGuard private key, generated here and never sent anywhere. */
  clientPrivateKey: string;
  /** Loopback port for the mixed (HTTP + SOCKS) inbound. */
  proxyPort: number;
  /**
   * Peer address to dial. Pass an IP to keep the handshake off DNS; a hostname
   * works too and gets a bootstrap DNS rule.
   */
  peerAddress?: string;
}

/** Tags, shared with the Dart builder. */
export const WG_TAG = "wg-out";
export const MIXED_INBOUND_TAG = "mixed-in";
export const PROXY_HOST = "127.0.0.1";

export function buildEgressConfig(opts: EgressConfigOptions): Record<string, unknown> {
  const wg = opts.bundle.wireguard ?? {};
  const serverPublicKey = (wg.server_public_key ?? "").trim();
  const endpoint = (wg.endpoint ?? "").trim();
  const address = (wg.address ?? "").trim();
  if (!serverPublicKey || !endpoint || !address) {
    throw new Error("credential bundle is missing wireguard fields");
  }
  if (!opts.clientPrivateKey.trim()) throw new Error("client private key is required");
  if (!Number.isInteger(opts.proxyPort) || opts.proxyPort < 1 || opts.proxyPort > 65535) {
    throw new Error(`proxy port ${opts.proxyPort} is not a usable port`);
  }

  const [host, port] = splitHostPort(endpoint);
  const peer = (opts.peerAddress ?? host).trim() || host;
  const dnsServer = (wg.dns ?? "").trim() || "1.1.1.1";

  // A hostname peer has to be resolvable before the tunnel exists, so it is
  // pinned to the direct resolver; an IP literal needs no rule.
  const bootstrapDomains = isIpLiteral(peer) ? [] : [peer];

  return {
    log: { level: "warn" },
    dns: {
      servers: [
        { tag: "dns-direct", address: "1.1.1.1", detour: "direct" },
        { tag: "dns-remote", address: dnsServer, detour: WG_TAG },
      ],
      ...(bootstrapDomains.length
        ? { rules: bootstrapDomains.map((domain) => ({ domain: [domain], server: "dns-direct" })) }
        : {}),
      final: "dns-remote",
      strategy: "prefer_ipv4",
    },
    // Loopback only, and no TUN: this process has no business holding a
    // system-wide tunnel, and a proxy on 0.0.0.0 is an open relay for the
    // agent host's whole LAN. `config.ts` in this repo defaults the MCP HTTP
    // transport to 0.0.0.0; this must not copy that.
    inbounds: [
      {
        type: "mixed",
        tag: MIXED_INBOUND_TAG,
        listen: PROXY_HOST,
        listen_port: opts.proxyPort,
        sniff: true,
      },
    ],
    outbounds: [{ type: "direct", tag: "direct" }],
    endpoints: [
      {
        type: "wireguard",
        tag: WG_TAG,
        address: interfacePrefixes(address),
        private_key: opts.clientPrivateKey.trim(),
        mtu: 1280,
        peers: [
          {
            address: peer,
            port,
            public_key: serverPublicKey,
            allowed_ips: ["0.0.0.0/0", "::/0"],
            persistent_keepalive_interval: 25,
          },
        ],
      },
    ],
    route: {
      // Order matters. The peer bypass has to come before everything, or the
      // tunnel's own handshake is routed into the tunnel. Exactly one bypass:
      // a second one is how traffic escapes.
      rules: [
        ...(peer && peer !== PROXY_HOST ? [directBypassRule(peer)] : []),
        { protocol: "dns", action: "hijack-dns" },
        { ip_cidr: ["127.0.0.0/8"], outbound: "direct" },
      ],
      final: WG_TAG,
      auto_detect_interface: true,
    },
  };
}

/** wg-quick `Address` list or a bare address → sing-box prefixes. */
export function interfacePrefixes(address: string): string[] {
  const out: string[] = [];
  for (const part of address.split(",")) {
    const a = part.trim();
    if (!a) continue;
    out.push(a.includes("/") ? a : `${a}/${a.includes(":") ? 128 : 32}`);
  }
  return out;
}

export function splitHostPort(hostPort: string): [string, number] {
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(hostPort);
  if (v6) return [v6[1]!, Number(v6[2])];
  const idx = hostPort.lastIndexOf(":");
  if (idx > 0 && !hostPort.slice(idx + 1).includes(":")) {
    const port = Number(hostPort.slice(idx + 1));
    if (Number.isInteger(port) && port > 0) return [hostPort.slice(0, idx), port];
  }
  return [hostPort, 51820];
}

export function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return /^[0-9a-fA-F:.]+$/.test(host.replace(/^\[|\]$/g, ""));
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return /^\d+$/.test(p) && n >= 0 && n <= 255;
  });
}

function directBypassRule(host: string): Record<string, unknown> {
  if (isIpLiteral(host)) {
    return { ip_cidr: [host.includes(":") ? `${host}/128` : `${host}/32`], outbound: "direct" };
  }
  return { domain: [host], outbound: "direct" };
}
