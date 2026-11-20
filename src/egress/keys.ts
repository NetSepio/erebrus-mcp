import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

/**
 * WireGuard keys without a dependency.
 *
 * Node has X25519 built in, but WireGuard speaks raw 32-byte scalars in
 * standard base64 while Node exports DER/PEM or JWK. JWK is the only export
 * that hands over the raw scalar, so the conversion goes through it: `d` is the
 * private half and `x` the public one, both base64url, which differs from
 * base64 in two characters and the padding.
 */
export interface WireGuardKeyPair {
  /** base64, 32 bytes. Never log this. */
  privateKey: string;
  /** base64, 32 bytes. Safe to send to the gateway. */
  publicKey: string;
}

export function generateWireGuardKeyPair(): WireGuardKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey: exportPrivate(privateKey),
    publicKey: exportPublic(publicKey),
  };
}

/**
 * PKCS#8 header for an X25519 private key, followed by the 32-byte scalar.
 * JWK import is no use for this direction: Node demands both halves of an OKP
 * key, and the public half is exactly what is being derived.
 */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** Public half of a base64 WireGuard private key. */
export function publicKeyFromPrivate(privateKey: string): string {
  const raw = decodeKey(privateKey, "private key");
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  return exportPublic(createPublicKey(key));
}

function exportPrivate(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { crv?: string; d?: string };
  if (jwk.crv !== "X25519" || !jwk.d) throw new Error("not an X25519 private key");
  return toBase64(jwk.d, "private key");
}

function exportPublic(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { crv?: string; x?: string };
  if (jwk.crv !== "X25519" || !jwk.x) throw new Error("not an X25519 public key");
  return toBase64(jwk.x, "public key");
}

function toBase64(base64url: string, what: string): string {
  const raw = Buffer.from(base64url, "base64url");
  if (raw.length !== 32) throw new Error(`${what} is ${raw.length} bytes, want 32`);
  return raw.toString("base64");
}

function decodeKey(value: string, what: string): Buffer {
  const raw = Buffer.from(value.trim(), "base64");
  if (raw.length !== 32) throw new Error(`${what} is ${raw.length} bytes, want 32`);
  return raw;
}
