import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EgressRegistry } from "../src/egress/registry.js";
import { EgressProcess, accepts, allocatePort } from "../src/egress/supervisor.js";

/** A stand-in for sing-box: reads the config it was given and listens on its
 *  inbound port, which is all the supervisor's readiness check looks for. */
function fakeSingbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "erebrus-egress-test-"));
  const path = join(dir, "fake-sing-box");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      // sing-box is called as: <binary> run -c <config>
      `exec ${JSON.stringify(process.execPath)} -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));require("net").createServer(s=>s.end()).listen(c.inbounds[0].listen_port,"127.0.0.1");setInterval(()=>{},1000);' "$3"`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

test("an allocated port is free until something listens on it", async () => {
  const port = await allocatePort();
  assert.ok(port > 1024);
  assert.equal(await accepts(port), false);
});

test("start waits for the proxy, and stop leaves nothing behind", async () => {
  const port = await allocatePort();
  const proc = await EgressProcess.start({
    binary: fakeSingbox(),
    proxyPort: port,
    config: { inbounds: [{ listen_port: port }] },
  });
  assert.ok(proc.pid > 0);
  assert.equal(await accepts(port), true);
  assert.ok(existsSync(proc.configPath), "the config is written for the child to read");

  await proc.stop();
  assert.equal(await accepts(port), false, "the child must be gone, not merely detached");
  // The config holds the client's private key, so it does not outlive the run.
  assert.equal(existsSync(proc.configPath), false);
});

test("a binary that cannot run is reported, not left half-started", async () => {
  const port = await allocatePort();
  await assert.rejects(
    EgressProcess.start({
      binary: process.execPath,
      proxyPort: port,
      config: { inbounds: [{ listen_port: port }] },
      readyTimeoutMs: 4000,
    }),
    /sing-box exited|did not start listening/,
  );
  assert.equal(await accepts(port), false);
});

test("the session cap is enforced", () => {
  const registry = new EgressRegistry(1, join(mkdtempSync(join(tmpdir(), "erebrus-reg-")), "s.json"));
  const row = {
    id: "a",
    proxyPort: 1,
    proxyUrl: "http://127.0.0.1:1",
    nodeId: "n",
    pid: 1,
    startedAt: new Date().toISOString(),
    configPath: "/tmp/none.json",
  };
  registry.add(row);
  assert.throws(() => registry.add({ ...row, id: "b" }), /EREBRUS_EGRESS_MAX_SESSIONS/);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("a")?.nodeId, "n");
  assert.equal(registry.remove("a")?.id, "a");
  assert.equal(registry.list().length, 0);
});

test("the orphan sweep kills nothing it cannot identify", () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "erebrus-reg-")), "s.json");
  // A pid that is alive but is not one of ours: a recycled pid must never be
  // killed on the strength of the number alone.
  writeFileSync(
    stateFile,
    JSON.stringify([{ id: "x", pid: process.pid, configPath: "/tmp/not-a-session.json" }]),
  );
  assert.equal(new EgressRegistry(2, stateFile).sweepOrphans(), 0);
});
