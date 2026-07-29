export type NodeProfile = "standard" | "shield" | "sentinel";
export type NodeAccess = "public" | "private";

export interface InstallPlanInput {
  access: NodeAccess;
  profile?: NodeProfile;
  drop?: boolean;
  nodeName?: string;
  region?: string;
  zone?: string;
  registrationToken: string;
  /** If true, include --skip-checks (cloud firewall / probe issues). */
  skipChecks?: boolean;
  gatewayUrl?: string;
}

/**
 * Compose a safe install plan. Does not SSH or run anything remotely.
 * MNEMONIC is intentionally NOT generated here — operator/agent should generate
 * offline and inject, or let installer generate when interactive.
 */
export function buildNodeInstallPlan(input: InstallPlanInput): {
  summary: string;
  ports: { port: string; proto: string; purpose: string }[];
  env: Record<string, string>;
  install_command: string;
  notes: string[];
  next_steps: string[];
} {
  const profile = input.profile ?? "standard";
  const drop = Boolean(input.drop);
  const gatewayUrl = input.gatewayUrl ?? "https://gateway.erebrus.io";

  const ports = [
    { port: "9080", proto: "tcp", purpose: "REST API + dashboard" },
    { port: "51820", proto: "udp", purpose: "WireGuard" },
    { port: "443", proto: "tcp", purpose: "VLESS+REALITY stealth" },
    { port: "443", proto: "udp", purpose: "Hysteria2 stealth" },
  ];
  if (drop) {
    ports.push({ port: "4001", proto: "tcp+udp", purpose: "Drop Kubo swarm" });
  }

  const env: Record<string, string> = {
    EREBRUS_ACCESS: input.access,
    EREBRUS_NODE_REGISTRATION_TOKEN: input.registrationToken,
    GATEWAY_URL: gatewayUrl,
    EREBRUS_PROFILE: profile,
  };
  if (input.nodeName) env.NODE_NAME = input.nodeName;
  if (input.region) env.REGION = input.region;
  if (input.zone) env.ZONE = input.zone;
  if (drop) env.DROP_ENABLED = "true";

  const flags = [`--profile ${profile}`, input.access === "public" ? "" : "", drop ? "--drop" : "", "--yes"]
    .filter(Boolean)
    .join(" ");
  const skip = input.skipChecks ? " --skip-checks" : "";

  // Shell-safe env prefix (token may contain only [a-z0-9_])
  const envExport = Object.entries(env)
    .map(([k, v]) => `${k}=${shellSingleQuote(v)}`)
    .join(" \\\n  ");

  const install_command = `${envExport} \\\n  curl -fsSL https://erebrus.io/install.sh | bash -s -- ${flags}${skip}`.trim();

  const notes = [
    "Requires Linux x86_64/arm64 with a static public IP.",
    "MNEMONIC: set a 12-word phrase in the environment before install, or use a patched installer that preserves env labels.",
    "Open the listed ports on host UFW and any cloud security group.",
    "ZONE is free-form outside the US (e.g. sydney). US may auto-set east/west if ZONE is unset.",
    "Store the registration token and mnemonic offline — they are not recoverable from the gateway.",
  ];

  return {
    summary: `Erebrus ${profile} node (${input.access}${drop ? ", Drop enabled" : ""}) install plan`,
    ports,
    env: {
      ...env,
      // placeholder so agents know to set it
      MNEMONIC: "<generate-12-word-bip39-and-backup>",
    },
    install_command,
    notes,
    next_steps: [
      "Generate and back up a BIP39 12-word MNEMONIC; export it in the same env block.",
      "Open required ports, then run install_command on the target host as root.",
      "Verify: curl -s http://127.0.0.1:9080/api/v2/status and org_nodes_list on the gateway.",
    ],
  };
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
