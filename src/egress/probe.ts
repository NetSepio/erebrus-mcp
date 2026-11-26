import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { PROXY_HOST } from "./config.js";

/**
 * A single HTTPS GET through the egress proxy, using HTTP CONNECT.
 *
 * CONNECT is the point, not an implementation detail. Node's `fetch` resolves
 * a hostname **locally** before dialling, so wiring an agent's fetch at a proxy
 * naively sends the agent's own resolver every hostname it visits: the censor
 * or the corporate resolver still sees exactly where the agent went while the
 * agent believes it is tunnelled. Sending the hostname to the proxy in the
 * CONNECT line puts resolution inside the tunnel, where it belongs.
 *
 * Deliberately small: `Connection: close` means the body is everything up to
 * EOF, so there is no chunked decoder to get wrong.
 */
export async function getThroughProxy(
  proxyPort: number,
  url: string,
  timeoutMs = 8000,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("only https URLs go through the proxy");
  const port = Number(target.port || 443);
  const socket = await connectThrough(proxyPort, target.hostname, port, timeoutMs);

  return await new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: target.hostname }, () => {
      tls.write(
        [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          "User-Agent: erebrus-mcp",
          "Accept: */*",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error(`timed out reading ${target.host} through the egress`));
    }, timeoutMs);
    const chunks: Buffer[] = [];
    tls.on("data", (c: Buffer) => chunks.push(c));
    tls.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    tls.once("end", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      const head = split === -1 ? raw : raw.slice(0, split);
      const body = split === -1 ? "" : raw.slice(split + 4);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ status, body });
    });
  });
}

/** Opens a tunnelled TCP connection to host:port through the mixed inbound. */
function connectThrough(
  proxyPort: number,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ReturnType<typeof netConnect>> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: PROXY_HOST, port: proxyPort });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("egress proxy did not answer CONNECT")), timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    socket.once("connect", () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 8192) fail(new Error("egress proxy sent an oversized CONNECT reply"));
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      if (status !== 200) {
        fail(new Error(`egress proxy refused CONNECT ${host}:${port} with ${status || "no status"}`));
        return;
      }
      // Anything after the blank line is already TLS payload; with a fresh
      // CONNECT there is none, and a proxy that sends some is not one we can
      // hand to tls.connect safely.
      if (head.length > end + 4) {
        fail(new Error("egress proxy sent data before the tunnel was established"));
        return;
      }
      resolve(socket);
    };
    socket.on("data", onData);
  });
}
