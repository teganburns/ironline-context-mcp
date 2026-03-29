import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  upsertMemory,
  searchMemory,
  getMemoryByKey,
  deleteMemoryByKey,
} from "./lancedb.js";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function registerTools(server: McpServer) {
  server.tool(
    "memory_store",
    "Store or update a memory entry with semantic search capability. Embeds content as a vector. Overwrites any existing entry for this key. Use for contact summaries, conversation highlights, and rich notes.",
    {
      key: z
        .string()
        .describe(
          "Unique key — use contact phone/email (e.g. +13128344710) or a topic slug (e.g. 'open-tasks', 'pricing')"
        ),
      content: z
        .string()
        .describe(
          "Markdown content to store. For contacts: name, role, notes, preferences. For topics: freeform notes."
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags for filtering (e.g. ['contact', 'vip'])"),
    },
    async ({ key, content, tags = [] }) => {
      try {
        const result = await upsertMemory(key, content, tags);
        return ok({ key, id: result.id, stored: true });
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    }
  );

  server.tool(
    "memory_search",
    "Search stored memories by semantic similarity. Returns the most relevant entries ranked by vector distance (lower score = more relevant). Use when you need to find context by meaning rather than exact key.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)"),
      filter_key: z
        .string()
        .optional()
        .describe(
          "Restrict search to entries with this exact key — useful for searching within one contact's history"
        ),
    },
    async ({ query, limit = 10, filter_key }) => {
      try {
        const results = await searchMemory(query, limit, filter_key);
        return ok(results);
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    }
  );

  server.tool(
    "memory_get",
    "Retrieve a memory entry by exact key. No vector search — use when you already know the key.",
    {
      key: z
        .string()
        .describe("Exact memory key — contact phone/email or topic slug"),
    },
    async ({ key }) => {
      try {
        const results = await getMemoryByKey(key);
        if (results.length === 0)
          return ok({ key, found: false, content: null });
        const row = results[0]!;
        return ok({
          key,
          found: true,
          content: row.content,
          tags: row.tags,
          updated_at: row.updated_at,
        });
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    }
  );

  server.tool(
    "memory_delete",
    "Delete all memory entries for a key. Irreversible.",
    {
      key: z
        .string()
        .describe("Memory key to delete — contact phone/email or topic slug"),
    },
    async ({ key }) => {
      try {
        await deleteMemoryByKey(key);
        return ok({ key, deleted: true });
      } catch (e: any) {
        return err(e?.message ?? String(e));
      }
    }
  );
}
