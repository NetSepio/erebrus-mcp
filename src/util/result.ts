import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Build a structured MCP tool result with JSON text + optional next steps. */
export function toolResult(
  data: unknown,
  opts?: { nextSteps?: string[]; isError?: boolean },
): CallToolResult {
  const payload =
    opts?.nextSteps?.length && data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, next_steps: opts.nextSteps }
      : opts?.nextSteps?.length
        ? { data, next_steps: opts.nextSteps }
        : data;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent:
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : { result: payload },
    isError: opts?.isError ?? false,
  };
}

export function toolError(message: string, detail?: unknown): CallToolResult {
  return toolResult(
    {
      error: message,
      detail: detail ?? undefined,
    },
    { isError: true },
  );
}
