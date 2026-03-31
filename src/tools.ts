import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  upsertProfileMemory,
  appendMemory,
  searchUserMemory,
  getUserMemories,
  deleteUserMemory,
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
    "Store a memory for a specific user. content_type='profile' upserts the contact summary (overwrites previous). content_type='text' or 'image' appends a new entry without removing anything. Always pass the sender's phone/email as user_key.",
    {
      user_key: z
        .string()
        .describe("Contact identifier — phone number (e.g. +13128344710) or email"),
      content: z
        .string()
        .describe(
          "Markdown content. For profile: name, role, notes. For text: a note or event. For image: a description of the image."
        ),
      content_type: z
        .enum(["text", "image", "profile"])
        .optional()
        .describe("Type of memory — 'profile' upserts the contact summary; 'text'/'image' append. Default: 'text'"),
      source_chat_id: z
        .string()
        .optional()
        .describe("The chat_id where this memory originated"),
      source_type: z
        .enum(["1:1", "group", "system"])
        .optional()
        .describe("Whether this came from a 1:1 or group chat. Default: '1:1'"),
      image_path: z
        .string()
        .optional()
        .describe("Local file path to the image (only for content_type='image')"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Optional tags (e.g. ['vip', 'follow-up'])"),
    },
    async ({
      user_key,
      content,
      content_type = "text",
      source_chat_id = "",
      source_type = "1:1",
      image_path = "",
      tags = [],
    }) => {
      console.log(`[context-mcp] memory_store user=${user_key} type=${content_type}`);
      try {
        if (content_type === "profile") {
          const result = await upsertProfileMemory(user_key, content, tags);
          console.log(`[context-mcp] memory_store ok id=${result.id} table=${result.table}`);
          return ok({ user_key, id: result.id, table: result.table, stored: true });
        } else {
          const result = await appendMemory(
            user_key,
            content,
            content_type,
            source_chat_id,
            source_type,
            image_path,
            tags
          );
          console.log(`[context-mcp] memory_store ok id=${result.id} table=${result.table}`);
          return ok({ user_key, id: result.id, table: result.table, stored: true });
        }
      } catch (e: any) {
        console.error(`[context-mcp] memory_store FAILED user=${user_key} type=${content_type}:`, e);
        return err(e?.message ?? String(e));
      }
    }
  );

  server.tool(
    "memory_search",
    "Search a user's memories by semantic similarity. Always scoped to one user. Returns the most relevant entries ranked by vector distance (lower score = more relevant).",
    {
      user_key: z
        .string()
        .describe("Contact identifier — phone number or email"),
      query: z.string().describe("Natural language search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)"),
      content_type: z
        .enum(["text", "image", "profile"])
        .optional()
        .describe("Filter results to a specific content type"),
    },
    async ({ user_key, query, limit = 10, content_type }) => {
      console.log(`[context-mcp] memory_search user=${user_key} query="${query}" type=${content_type ?? "any"}`);
      try {
        const results = await searchUserMemory(user_key, query, limit, content_type);
        console.log(`[context-mcp] memory_search ok count=${results.length}`);
        return ok(results);
      } catch (e: any) {
        console.error(`[context-mcp] memory_search FAILED user=${user_key}:`, e);
        return err(e?.message ?? String(e));
      }
    }
  );

  server.tool(
    "memory_get_user",
    "Retrieve stored memories for a user. Use content_type='profile' at the start of every conversation to load the contact summary. Returns entries sorted newest first.",
    {
      user_key: z
        .string()
        .describe("Contact identifier — phone number or email"),
      content_type: z
        .enum(["text", "image", "profile"])
        .optional()
        .describe("Filter to a specific content type. Omit to get all."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max entries to return (default 20)"),
    },
    async ({ user_key, content_type, limit = 20 }) => {
      console.log(`[context-mcp] memory_get_user user=${user_key} type=${content_type ?? "any"}`);
      try {
        const results = await getUserMemories(user_key, content_type, limit);
        console.log(`[context-mcp] memory_get_user ok count=${results.length}`);
        return ok({ user_key, count: results.length, memories: results });
      } catch (e: any) {
        console.error(`[context-mcp] memory_get_user FAILED user=${user_key}:`, e);
        return err(e?.message ?? String(e));
      }
    }
  );

  server.tool(
    "memory_delete",
    "Delete a memory entry. Pass id to delete a single entry. Omit id to delete ALL memories for this user (drops their table entirely). Irreversible.",
    {
      user_key: z
        .string()
        .describe("Contact identifier — phone number or email"),
      id: z
        .string()
        .optional()
        .describe("ID of a specific memory entry to delete. If omitted, deletes all memories for this user."),
    },
    async ({ user_key, id }) => {
      console.log(`[context-mcp] memory_delete user=${user_key} id=${id ?? "all"}`);
      try {
        await deleteUserMemory(user_key, id);
        console.log(`[context-mcp] memory_delete ok`);
        return ok({ user_key, id: id ?? null, deleted: true });
      } catch (e: any) {
        console.error(`[context-mcp] memory_delete FAILED user=${user_key}:`, e);
        return err(e?.message ?? String(e));
      }
    }
  );
}
