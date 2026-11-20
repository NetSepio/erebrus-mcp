import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPathAllowed } from "../src/client/gateway.js";

/**
 * Every path the tools use has to pass our own allowlist before it reaches the
 * gateway. Forgetting an entry produces a 403 from this client, which reads
 * exactly like a gateway permission problem and sends the reader the wrong way.
 */
test("the egress and billing paths are allowed", () => {
  for (const path of [
    "/api/v2/nodes",
    "/api/v2/regions",
    "/api/v2/bootstrap",
    "/api/v2/vpn/clients",
    "/api/v2/vpn/clients/abc/config",
    "/api/v2/orgs/00000000-0000-0000-0000-000000000001/billing/crypto/intent",
    "/api/v2/orgs/00000000-0000-0000-0000-000000000001/billing/crypto/intent/xyz",
  ]) {
    assert.doesNotThrow(() => assertPathAllowed(path), `${path} must be allowed`);
  }
});

test("the blocked surfaces stay blocked", () => {
  for (const path of [
    "/api/v2/admin/nodes",
    "/api/v2/rank",
    "/api/v2/leaderboard",
    "/api/v2/orgs/x/firewall/rules",
    "/api/v2/something-else",
  ]) {
    assert.throws(() => assertPathAllowed(path), `${path} must be refused`);
  }
});
