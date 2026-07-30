import { randomUUID } from "node:crypto";
import { z } from "zod";
import { toolResult } from "../util/result.js";
import { mapError } from "../util/errors.js";
import type { ToolContext } from "./context.js";

export function registerDropTools(ctx: ToolContext): void {
  const { server, client } = ctx;

  server.registerTool(
    "drop_nodes_list",
    {
      title: "List Drop-capable nodes",
      description:
        "List nodes available for Drop uploads (GET /api/v2/drop/nodes). " +
        "scope=public or private (private requires org_id).",
      inputSchema: {
        scope: z.enum(["public", "private"]).describe("Drop scope"),
        org_id: z.string().optional().describe("Required when scope=private"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scope, org_id }) => {
      try {
        const query: Record<string, string> = { scope };
        if (org_id) query.org_id = org_id;
        const res = await client.request<unknown>({
          path: "/api/v2/drop/nodes",
          auth: "bearer",
          query,
        });
        return toolResult(res);
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_upload_reserve",
    {
      title: "Reserve Drop upload",
      description:
        "Reserve an upload slot (POST /api/v2/drop/uploads). Then call drop_upload_content with the upload id.",
      inputSchema: {
        node_id: z.string().min(1),
        size_bytes: z.number().int().positive(),
        filename: z.string().optional(),
        content_type: z.string().optional(),
        scope: z.enum(["public", "private"]).optional().describe("Default public"),
        visibility: z
          .enum(["public", "private"])
          .optional()
          .describe("File visibility; private requires client-side encryption metadata"),
        org_id: z.string().optional().describe("Required for private/org scope"),
        sha256: z.string().optional().describe("64-char hex digest"),
        encrypted: z.boolean().optional(),
        encryption_metadata: z.unknown().optional(),
        idempotency_key: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          node_id: args.node_id,
          size_bytes: args.size_bytes,
          scope: args.scope ?? "public",
          idempotency_key: args.idempotency_key ?? randomUUID(),
        };
        if (args.filename) body.filename = args.filename;
        if (args.content_type) body.content_type = args.content_type;
        if (args.visibility) body.visibility = args.visibility;
        if (args.org_id) body.org_id = args.org_id;
        if (args.sha256) body.sha256 = args.sha256;
        if (args.encrypted !== undefined) body.encrypted = args.encrypted;
        if (args.encryption_metadata !== undefined) {
          body.encryption_metadata = args.encryption_metadata;
        }
        const upload = await client.request<unknown>({
          path: "/api/v2/drop/uploads",
          method: "POST",
          auth: "bearer",
          body,
        });
        return toolResult(
          { upload },
          {
            nextSteps: [
              "drop_upload_content with upload id and base64 file bytes",
              "drop_upload_status / drop_files_list to confirm",
            ],
          },
        );
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_upload_content",
    {
      title: "Upload Drop file bytes",
      description:
        "PUT raw content for a reserved upload (base64-encoded body, max ~15MB decoded recommended for MCP).",
      inputSchema: {
        upload_id: z.string().min(1),
        content_base64: z.string().min(1).describe("File bytes as standard base64"),
        content_type: z.string().optional().describe("Default application/octet-stream"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ upload_id, content_base64, content_type }) => {
      try {
        const buf = Buffer.from(content_base64, "base64");
        if (buf.length === 0) {
          return toolResult({ error: "decoded content is empty" }, { isError: true });
        }
        if (buf.length > 15 * 1024 * 1024) {
          return toolResult(
            {
              error: "content too large for MCP tool (>15MB). Use a smaller file or gateway client directly.",
            },
            { isError: true },
          );
        }
        const result = await client.request<unknown>({
          path: `/api/v2/drop/uploads/${encodeURIComponent(upload_id)}/content`,
          method: "PUT",
          auth: "bearer",
          rawBody: buf,
          contentType: content_type ?? "application/octet-stream",
        });
        return toolResult({ upload_id, result, bytes: buf.length });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_upload_status",
    {
      title: "Drop upload status",
      description: "GET status for a reserved/in-progress upload.",
      inputSchema: { upload_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ upload_id }) => {
      try {
        const status = await client.request<unknown>({
          path: `/api/v2/drop/uploads/${encodeURIComponent(upload_id)}`,
          auth: "bearer",
        });
        return toolResult({ status });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_files_list",
    {
      title: "List Drop files",
      description: "List authenticated user's Drop files.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const files = await client.request<unknown>({
          path: "/api/v2/drop/files",
          auth: "bearer",
        });
        return toolResult({ files });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_file_get",
    {
      title: "Get Drop file metadata",
      description: "Get metadata for one Drop file.",
      inputSchema: { file_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ file_id }) => {
      try {
        const file = await client.request<unknown>({
          path: `/api/v2/drop/files/${encodeURIComponent(file_id)}`,
          auth: "bearer",
        });
        return toolResult({ file });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_file_delete",
    {
      title: "Delete Drop file",
      description: "Delete a Drop file by id.",
      inputSchema: { file_id: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ file_id }) => {
      try {
        await client.request({
          path: `/api/v2/drop/files/${encodeURIComponent(file_id)}`,
          method: "DELETE",
          auth: "bearer",
        });
        return toolResult({ file_id, deleted: true });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "drop_usage",
    {
      title: "Drop storage usage",
      description: "User Drop usage stats.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const usage = await client.request<unknown>({
          path: "/api/v2/drop/usage",
          auth: "bearer",
        });
        return toolResult({ usage });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_drop_files",
    {
      title: "List org Drop files",
      description: "Org-scoped Drop file metadata (GET /orgs/{id}/drop/files).",
      inputSchema: { org_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const files = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/drop/files`,
          auth: "bearer",
        });
        return toolResult({ org_id: id, files });
      } catch (e) {
        return mapError(e);
      }
    },
  );

  server.registerTool(
    "org_drop_usage",
    {
      title: "Org Drop usage",
      description: "Org-scoped Drop usage (GET /orgs/{id}/drop/usage).",
      inputSchema: { org_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ org_id }) => {
      try {
        const id = client.resolveOrgId(org_id);
        const usage = await client.request<unknown>({
          path: `/api/v2/orgs/${encodeURIComponent(id)}/drop/usage`,
          auth: "bearer",
        });
        return toolResult({ org_id: id, usage });
      } catch (e) {
        return mapError(e);
      }
    },
  );
}
