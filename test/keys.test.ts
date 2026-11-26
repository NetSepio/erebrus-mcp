import assert from "node:assert/strict";
import { test } from "node:test";
import { generateWireGuardKeyPair, publicKeyFromPrivate } from "../src/egress/keys.js";

/**
 * WireGuard wants raw 32-byte X25519 scalars in standard base64, while Node
 * exports DER, PEM or JWK. The conversion goes through JWK's base64url, which
 * differs from base64 in two characters and the padding — exactly the kind of
 * mistake that produces a key the node accepts and a tunnel that never carries
 * a packet, so it is pinned to the RFC 7748 §6.1 vector.
 */
const rfc7748 = {
  privateHex: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  publicHex: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
};

test("derives the RFC 7748 public key from its private key", () => {
  const priv = Buffer.from(rfc7748.privateHex, "hex").toString("base64");
  const pub = publicKeyFromPrivate(priv);
  assert.equal(Buffer.from(pub, "base64").toString("hex"), rfc7748.publicHex);
});

test("generates distinct 32-byte base64 keys that round-trip", () => {
  const a = generateWireGuardKeyPair();
  const b = generateWireGuardKeyPair();
  assert.notEqual(a.privateKey, b.privateKey);
  for (const key of [a.privateKey, a.publicKey]) {
    assert.equal(Buffer.from(key, "base64").length, 32);
    // Standard base64, not base64url: a '-' or '_' here is a key the node
    // will reject or, worse, silently mis-decode.
    assert.match(key, /^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}$/);
  }
  assert.equal(publicKeyFromPrivate(a.privateKey), a.publicKey);
});

test("refuses keys that are not 32 bytes", () => {
  assert.throws(() => publicKeyFromPrivate(Buffer.alloc(16).toString("base64")), /32/);
  assert.throws(() => publicKeyFromPrivate("not base64 at all"), /32/);
});
