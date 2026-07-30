import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GatewayError } from "../client/gateway.js";
import { toolError } from "./result.js";

export function mapError(e: unknown): CallToolResult {
  if (e instanceof GatewayError) {
    return toolError(e.message, { status: e.status, body: e.body });
  }
  return toolError(e instanceof Error ? e.message : String(e));
}
