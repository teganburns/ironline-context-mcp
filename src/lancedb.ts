/**
 * LanceDB Cloud — per-user table memory for ironline-context-mcp.
 *
 * Each contact gets its own table named contact_<sanitized_phone_or_email>.
 * Schema: id, source_chat_id, source_type, content_type, content, image_path, tags, vector, created_at
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";

const LANCEDB_URI = "db://default-t4u99m";
const LANCEDB_REGION = "us-east-1";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

// ── Env validation ────────────────────────────────────────────────────────────

const LANCE_API_KEY = process.env.LANCE_DB_DEFAULT_API_KEY;
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY_AMANDA_IRONLINE_AGENT ?? process.env.OPENAI_API_KEY;

if (!LANCE_API_KEY) {
  console.error("LANCE_DB_DEFAULT_API_KEY env var is required");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY_AMANDA_IRONLINE_AGENT env var is required");
  process.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  source_chat_id: string;
  source_type: string;   // "1:1" | "group" | "system"
  content_type: string;  // "text" | "image" | "profile"
  content: string;
  image_path: string;    // "" if not an image
  tags: string;          // JSON-stringified string[]
  vector: number[];
  created_at: string;
}

export interface MemoryResult {
  id: string;
  source_chat_id: string;
  source_type: string;
  content_type: string;
  content: string;
  image_path: string;
  tags: string[];
  created_at: string;
  score: number;
}

// ── Connection + table singletons ─────────────────────────────────────────────

let _db: lancedb.Connection | null = null;
const _tables = new Map<string, lancedb.Table>();

async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    console.log(`[lancedb] connecting to ${LANCEDB_URI} (${LANCEDB_REGION})`);
    try {
      _db = await lancedb.connect(LANCEDB_URI, {
        apiKey: LANCE_API_KEY!,
        region: LANCEDB_REGION,
      });
      console.log(`[lancedb] connected`);
    } catch (e) {
      console.error(`[lancedb] connection FAILED:`, e);
      throw e;
    }
  }
  return _db;
}

/** Derive a stable LanceDB table name from a user key (phone/email). */
export function tableNameForKey(userKey: string): string {
  const sanitized = userKey
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/^_+|_+$/g, "");
  return `contact_${sanitized}`;
}

/** Open (or create) the table for a user key, caching the handle. */
async function getUserTable(userKey: string): Promise<lancedb.Table> {
  const tableName = tableNameForKey(userKey);
  const cached = _tables.get(tableName);
  if (cached) return cached;

  const db = await getDb();
  const tableNames = await db.tableNames();

  let table: lancedb.Table;
  if (tableNames.includes(tableName)) {
    console.log(`[lancedb] opening table ${tableName}`);
    table = await db.openTable(tableName);
    console.log(`[lancedb] opened table ${tableName}`);
  } else {
    // LanceDB Cloud requires at least one row to infer schema on createTable.
    // Keep the sentinel row permanently — deleting it leaves the table empty
    // and LanceDB Cloud returns 404 on subsequent writes. All queries filter
    // it out via content_type != "__bootstrap__".
    const zero = new Array(EMBEDDING_DIMS).fill(0) as number[];
    const sentinel: MemoryRow = {
      id: "__bootstrap__",
      source_chat_id: "",
      source_type: "system",
      content_type: "__bootstrap__",
      content: "",
      image_path: "",
      tags: "[]",
      vector: zero,
      created_at: new Date().toISOString(),
    };
    table = await db.createTable(tableName, [sentinel]);
    console.log(`[lancedb] created table ${tableName}`);
  }

  _tables.set(tableName, table);
  return table;
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export async function embed(text: string): Promise<number[]> {
  console.log(`[lancedb] embedding ${text.length} chars`);
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[lancedb] embedding FAILED ${response.status}: ${body}`);
    throw new Error(`OpenAI embeddings API error ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  const embedding = json.data[0]?.embedding;
  if (!embedding || embedding.length !== EMBEDDING_DIMS) {
    throw new Error(
      `Unexpected embedding shape: ${embedding?.length ?? "undefined"}`
    );
  }
  return embedding;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTags(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function rowToResult(r: Record<string, unknown>, score = 0): MemoryResult {
  return {
    id: String(r["id"] ?? ""),
    source_chat_id: String(r["source_chat_id"] ?? ""),
    source_type: String(r["source_type"] ?? ""),
    content_type: String(r["content_type"] ?? ""),
    content: String(r["content"] ?? ""),
    image_path: String(r["image_path"] ?? ""),
    tags: parseTags(String(r["tags"] ?? "[]")),
    created_at: String(r["created_at"] ?? ""),
    score: typeof r["_distance"] === "number" ? r["_distance"] : score,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Upsert a profile: delete existing "profile" rows in the user's table, then
 * insert a new one. Use for the canonical contact summary.
 */
export async function upsertProfileMemory(
  userKey: string,
  content: string,
  tags: string[]
): Promise<{ id: string; table: string }> {
  const table = await getUserTable(userKey);
  await table.delete(`content_type = "profile"`);

  const id = randomUUID();
  const vector = await embed(content);
  const row: MemoryRow = {
    id,
    source_chat_id: "",
    source_type: "system",
    content_type: "profile",
    content,
    image_path: "",
    tags: JSON.stringify(tags),
    vector,
    created_at: new Date().toISOString(),
  };

  console.log(`[lancedb] upsertProfile adding row id=${id}`);
  await table.add([row]);
  console.log(`[lancedb] upsertProfile ok id=${id}`);
  return { id, table: tableNameForKey(userKey) };
}

/**
 * Append a new memory row (text or image). Always inserts — never deletes.
 */
export async function appendMemory(
  userKey: string,
  content: string,
  contentType: "text" | "image",
  sourceChatId: string,
  sourceType: string,
  imagePath: string,
  tags: string[]
): Promise<{ id: string; table: string }> {
  const table = await getUserTable(userKey);

  const id = randomUUID();
  const vector = await embed(content);
  const row: MemoryRow = {
    id,
    source_chat_id: sourceChatId,
    source_type: sourceType,
    content_type: contentType,
    content,
    image_path: imagePath,
    tags: JSON.stringify(tags),
    vector,
    created_at: new Date().toISOString(),
  };

  console.log(`[lancedb] append adding row id=${id} type=${contentType}`);
  try {
    await table.add([row]);
  } catch (e: any) {
    // Table may be empty/stale (e.g. old bootstrap was deleted). Evict cache,
    // drop and recreate, then retry once.
    if (String(e?.message ?? e).includes("not found") || String(e?.message ?? e).includes("404")) {
      console.warn(`[lancedb] append got 404 for ${tableNameForKey(userKey)}, dropping and recreating`);
      _tables.delete(tableNameForKey(userKey));
      const db = await getDb();
      await db.dropTable(tableNameForKey(userKey)).catch(() => {});
      const freshTable = await getUserTable(userKey);
      await freshTable.add([row]);
    } else {
      throw e;
    }
  }
  console.log(`[lancedb] append ok id=${id}`);
  return { id, table: tableNameForKey(userKey) };
}

/**
 * ANN search within a user's table. Lower score = more similar.
 * Optionally filter by content_type.
 */
export async function searchUserMemory(
  userKey: string,
  query: string,
  limit = 10,
  contentType?: string
): Promise<MemoryResult[]> {
  const table = await getUserTable(userKey);
  const vector = await embed(query);

  let search = table.search(vector).limit(limit);
  if (contentType) {
    search = search.where(`content_type = ${JSON.stringify(contentType)}`);
  } else {
    search = search.where(`content_type != "__bootstrap__"`);
  }

  const raw = (await search.toArray()) as Array<Record<string, unknown>>;
  return raw.map((r) => rowToResult(r));
}

/**
 * SQL fetch of all rows for a user. Optionally filter by content_type.
 * Sorted by created_at descending (most recent first).
 */
export async function getUserMemories(
  userKey: string,
  contentType?: string,
  limit = 20
): Promise<MemoryResult[]> {
  const table = await getUserTable(userKey);

  let q = table.query().where(`content_type != "__bootstrap__"`);
  if (contentType) {
    q = q.where(`content_type = ${JSON.stringify(contentType)}`);
  }
  q = q.limit(limit);

  const rows = (await q.toArray()) as Array<Record<string, unknown>>;
  // Sort by created_at descending
  rows.sort((a, b) =>
    String(b["created_at"] ?? "").localeCompare(String(a["created_at"] ?? ""))
  );
  return rows.map((r) => rowToResult(r));
}

/**
 * Delete a single row (by id) or the entire user table (if no id given).
 */
export async function deleteUserMemory(
  userKey: string,
  id?: string
): Promise<{ deleted: boolean }> {
  if (id) {
    const table = await getUserTable(userKey);
    await table.delete(`id = ${JSON.stringify(id)}`);
  } else {
    const db = await getDb();
    const tableName = tableNameForKey(userKey);
    const tableNames = await db.tableNames();
    if (tableNames.includes(tableName)) {
      await db.dropTable(tableName);
      _tables.delete(tableName);
      console.log(`[lancedb] dropped table ${tableName}`);
    }
  }
  return { deleted: true };
}
