/** Keys whose values should be truncated in logs / accidental dumps. */
const SENSITIVE_KEY =
  /^(api_key|token|secret|mnemonic|password|authorization|bearer|node_key|registration_token)$/i;

/**
 * Deep-clone a JSON-ish value and redact sensitive string fields for logging.
 * Tool responses that intentionally return secrets once should NOT pass through this
 * before returning to the agent — only use for debug logs.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.startsWith("erebrus_sk_") || value.startsWith("ere_reg_")) {
      return redactString(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && typeof v === "string") {
        out[k] = redactString(v);
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function redactString(s: string): string {
  if (s.length <= 12) return "***";
  return `${s.slice(0, 10)}…${s.slice(-4)} (redacted, len=${s.length})`;
}
