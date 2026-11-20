import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveSingboxPath } from "../egress/binary.js";
import { buildEgressConfig, PROXY_HOST, type CredentialBundle } from "../egress/config.js";
import { generateWireGuardKeyPair } from "../egress/keys.js";
import { getThroughProxy } from "../egress/probe.js";
import { EgressRegistry } from "../egress/registry.js";
import { EgressProcess, allocatePort } from "../egress/supervisor.js";
import { mapError } from "../util/errors.js";
import { toolError, toolResult } from "../util/result.js";
import type { ToolContext } from "./context.js";

/** Where the egress IP is read from, through the tunnel. */
const EGRESS_IP_URL = "https://api.ipify.org/?format=json";

export function registerEgressTools(ctx: ToolContext): void {
  const { server, client } = ctx;
  const registry = new EgressRegistry(ctx.config.egressMaxSessions);
  const processes = new Map<string, EgressProcess>();

  // A sing-box from a previous run of this server is still proxying and still
  // holding a peer slot, so clear those before taking new sessions.
  registry.sweepOrphans();

  server.registerTool(
    "vpn_egress_start",
    {
      title: "Start an egress tunnel",
      description:
        "Provision a VPN client and run the tunnel here, returning a local HTTP/SOCKS proxy URL " +
        "the agent can use. The destination sees the Erebrus node's IP, in the region asked for. " +
        "The node operator still sees this host's IP (two-hop is what closes that), and anything " +
        "with root on this machine sees everything.",
      inputSchema: {
        region: z.string().optional().describe("Preferred node region, e.g. 'de'"),
        node_id: z.string().optional().describe("Exact node peer id; overrides region"),
        two_hop: z.boolean().optional().describe("Route through an entry and an exit node"),
        exit_region: z.string().optional().describe("Exit region when two_hop is set"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ region, node_id, two_hop }) => {
      if (two_hop) {
        // The two-hop endpoint graph is being written in the Dart builder
        // (T2). Mirroring it from a sketch is how the two implementations
        // drift, and a drifted two-hop silently degrades to single-hop with no
        // visible symptom — so refuse rather than guess.
        return toolError(
          "two_hop is not available yet: it mirrors the client's two-hop config, which lands with T2 in erebrus-vpn. Start a single-hop egress meanwhile.",
        );
      }
      let session: { id: string; clientId?: string } | undefined;
      let proc: EgressProcess | undefined;
      try {
        const binary = resolveSingboxPath();
        const node = await pickNode(ctx, { region, nodeId: node_id });
        const keys = generateWireGuardKeyPair();
        const created = await client.request<Record<string, unknown>>({
          path: "/api/v2/vpn/clients",
          method: "POST",
          auth: "bearer",
          body: {
            name: `agent-${randomUUID().slice(0, 8)}`,
            node_id: node.id,
            wg_public_key: keys.publicKey,
            idempotency_key: randomUUID(),
          },
        });
        const clientId = String(
          (created.client as Record<string, unknown> | undefined)?.id ?? created.id ?? "",
        );
        if (!clientId) throw new Error("the gateway did not return a client id");
        session = { id: randomUUID(), clientId };

        const bundle = await client.request<CredentialBundle>({
          path: `/api/v2/vpn/clients/${encodeURIComponent(clientId)}/config`,
          auth: "bearer",
        });
        const proxyPort = await allocatePort();
        proc = await EgressProcess.start({
          binary,
          proxyPort,
          config: buildEgressConfig({
            bundle,
            clientPrivateKey: keys.privateKey,
            proxyPort,
          }),
        });

        // Verify before returning. An agent handed a proxy URL has no other way
        // to know the tunnel carries traffic, and an HTTP client that quietly
        // falls back to direct is the worst outcome this feature has.
        const probe = await getThroughProxy(proxyPort, EGRESS_IP_URL);
        if (probe.status !== 200) {
          throw new Error(`the tunnel answered ${probe.status} instead of 200 on the egress check`);
        }
        let egressIp: string | undefined;
        try {
          egressIp = String((JSON.parse(probe.body) as { ip?: string }).ip ?? "") || undefined;
        } catch {
          // The tunnel works; only the IP read-back is unavailable.
        }

        const row = {
          id: session.id,
          proxyPort,
          proxyUrl: `http://${PROXY_HOST}:${proxyPort}`,
          nodeId: node.id,
          region: node.region,
          clientId,
          pid: proc.pid,
          startedAt: new Date().toISOString(),
          egressIp,
          configPath: proc.configPath,
        };
        registry.add(row);
        processes.set(session.id, proc);
        return toolResult(
          {
            session_id: row.id,
            proxy_url: row.proxyUrl,
            socks_url: `socks5h://${PROXY_HOST}:${proxyPort}`,
            node: { id: node.id, name: node.name, region: node.region },
            egress_ip: egressIp ?? null,
            observers: {
              destination: "sees the node's egress IP",
              node_operator: "sees this host's IP (two-hop closes this)",
              local_machine: "sees everything; this is a local process",
            },
          },
          {
            nextSteps: [
              "Point the agent's HTTP client at proxy_url, or socks_url for SOCKS5h",
              "vpn_egress_stop when finished — it also deletes the provisioned client",
            ],
          },
        );
      } catch (e) {
        // Leave nothing behind: a half-started egress must not hold a peer slot
        // or a sing-box process.
        if (proc) await proc.stop().catch(() => undefined);
        if (session?.clientId) await deleteClient(ctx, session.clientId);
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "vpn_egress_status",
    {
      title: "Egress status",
      description:
        "Live egress sessions with uptime and the egress IP measured at start. " +
        "Pass session_id to re-check one, which re-reads the egress IP through the tunnel.",
      inputSchema: { session_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session_id }) => {
      try {
        const rows = session_id
          ? [registry.get(session_id)].filter((r) => r !== undefined)
          : registry.list();
        if (session_id && rows.length === 0) {
          return toolError(`no egress session ${session_id}`);
        }
        const sessions = [];
        for (const row of rows) {
          const proc = processes.get(row.id);
          const running = proc ? proc.child.exitCode === null : false;
          let liveIp = row.egressIp ?? null;
          if (session_id && running) {
            try {
              const probe = await getThroughProxy(row.proxyPort, EGRESS_IP_URL, 6000);
              liveIp = String((JSON.parse(probe.body) as { ip?: string }).ip ?? "") || liveIp;
            } catch {
              liveIp = null;
            }
          }
          sessions.push({
            session_id: row.id,
            running,
            proxy_url: row.proxyUrl,
            node_id: row.nodeId,
            region: row.region ?? null,
            started_at: row.startedAt,
            uptime_seconds: Math.round((Date.now() - Date.parse(row.startedAt)) / 1000),
            egress_ip: liveIp,
          });
        }
        return toolResult({
          sessions,
          max_sessions: registry.maxSessions,
          // Byte counters need sing-box's Clash API, which means another
          // loopback listener; left out until that is worth its surface.
          note: "byte counters are not reported yet",
        });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "vpn_egress_stop",
    {
      title: "Stop an egress tunnel",
      description:
        "Tear down the tunnel and delete the VPN client it provisioned, so no peer slot is left held.",
      inputSchema: { session_id: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ session_id }) => {
      try {
        const row = registry.remove(session_id);
        if (!row) return toolError(`no egress session ${session_id}`);
        const proc = processes.get(session_id);
        processes.delete(session_id);
        if (proc) await proc.stop();
        const clientDeleted = row.clientId ? await deleteClient(ctx, row.clientId) : false;
        return toolResult({
          session_id,
          stopped: true,
          client_deleted: clientDeleted,
          node_id: row.nodeId,
        });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "vpn_regions_list",
    {
      title: "List regions",
      description: "Regions with node counts, for choosing where an egress should come out.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const regions = await client.request<unknown>({ path: "/api/v2/regions", auth: "none" });
        return toolResult({ regions });
      } catch (e) {
        return mapError(e);
      }
    },
  );
}

interface PickedNode {
  id: string;
  name?: string;
  region?: string;
}

/** Chooses a node for the egress: the named one, or the least loaded in region. */
async function pickNode(
  ctx: ToolContext,
  opts: { region?: string; nodeId?: string },
): Promise<PickedNode> {
  const raw = await ctx.client.request<unknown>({ path: "/api/v2/nodes", auth: "none" });
  const list = nodeList(raw);
  if (opts.nodeId) {
    const match = list.find((n) => n.id === opts.nodeId);
    // An unknown id is still worth trying: the directory hides private nodes
    // the caller may be entitled to.
    return match ?? { id: opts.nodeId };
  }
  const region = opts.region?.trim().toLowerCase();
  const usable = list.filter(
    (n) =>
      n.accepting !== false &&
      n.status !== "offline" &&
      (!region || (n.region ?? "").toLowerCase() === region),
  );
  if (usable.length === 0) {
    throw new Error(
      region
        ? `no node is accepting clients in region ${region} (vpn_regions_list shows what is available)`
        : "no node is accepting clients right now",
    );
  }
  usable.sort((a, b) => (a.load ?? 0) - (b.load ?? 0));
  return usable[0]!;
}

interface DirectoryNode extends PickedNode {
  status?: string;
  accepting?: boolean;
  load?: number;
}

/** The node list has been returned bare and wrapped; accept both. */
function nodeList(raw: unknown): DirectoryNode[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { nodes?: unknown })?.nodes)
      ? ((raw as { nodes: unknown[] }).nodes as unknown[])
      : Array.isArray((raw as { data?: unknown })?.data)
        ? ((raw as { data: unknown[] }).data as unknown[])
        : [];
  const out: DirectoryNode[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const n = item as Record<string, unknown>;
    const id = String(n.peer_id ?? n.node_id ?? n.id ?? "");
    if (!id) continue;
    out.push({
      id,
      name: n.name ? String(n.name) : undefined,
      region: n.region ? String(n.region) : undefined,
      status: n.status ? String(n.status) : undefined,
      accepting: typeof n.accepting_clients === "boolean" ? n.accepting_clients : undefined,
      load: typeof n.load_pct === "number" ? n.load_pct : undefined,
    });
  }
  return out;
}

async function deleteClient(ctx: ToolContext, clientId: string): Promise<boolean> {
  try {
    await ctx.client.request({
      path: `/api/v2/vpn/clients/${encodeURIComponent(clientId)}`,
      method: "DELETE",
      auth: "bearer",
    });
    return true;
  } catch {
    return false;
  }
}
