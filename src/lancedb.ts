/**
 * LanceDB Cloud connection + embedding helpers for ironline-context-mcp.
 *
 * Table: memories
 * Schema: id, key, content, tags, vector, updated_at
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";

const LANCEDB_URI = "db://default-t4u99m";
const LANCEDB_REGION = "us-east-1";
const TABLE_NAME = "memories";
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
  key: string;
  content: string;
  tags: string; // JSON-stringified string[]
  vector: number[];
  updated_at: string;
}

export interface MemoryResult {
  id: string;
  key: string;
  content: string;
  tags: string[];
  updated_at: string;
  score: number;
}

// ── Connection singletons ─────────────────────────────────────────────────────

let _db: lancedb.Connection | null = null;
let _table: lancedb.Table | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!_db) {
    _db = await lancedb.connect(LANCEDB_URI, {
      apiKey: LANCE_API_KEY!,
      region: LANCEDB_REGION,
    });
  }
  return _db;
}

async function getTable(): Promise<lancedb.Table> {
  if (_table) return _table;

  const db = await getDb();
  const tableNames = await db.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    _table = await db.openTable(TABLE_NAME);
  } else {
    // LanceDB Cloud requires at least one row to infer schema on createTable.
    // Insert a sentinel row then immediately delete it.
    const zero = new Array(EMBEDDING_DIMS).fill(0) as number[];
    const sentinel: MemoryRow = {
      id: "__bootstrap__",
      key: "__bootstrap__",
      content: "",
      tags: "[]",
      vector: zero,
      updated_at: new Date().toISOString(),
    };
    _table = await db.createTable(TABLE_NAME, [sentinel]);
    await _table.delete('id = "__bootstrap__"');
  }

  return _table;
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export async function embed(text: string): Promise<number[]> {
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
    key: String(r["key"] ?? ""),
    content: String(r["content"] ?? ""),
    tags: parseTags(String(r["tags"] ?? "[]")),
    updated_at: String(r["updated_at"] ?? ""),
    score: typeof r["_distance"] === "number" ? r["_distance"] : score,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Upsert: delete existing rows for this key, then insert a new row with a
 * fresh embedding.
 */
export async function upsertMemory(
  key: string,
  content: string,
  tags: string[]
): Promise<{ id: string }> {
  const table = await getTable();
  await table.delete(`key = ${JSON.stringify(key)}`);

  const id = randomUUID();
  const vector = await embed(content);

  const row: MemoryRow = {
    id,
    key,
    content,
    tags: JSON.stringify(tags),
    vector,
    updated_at: new Date().toISOString(),
  };

  await table.add([row]);
  return { id };
}

/**
 * ANN search: embed query, return top-k results ordered by vector distance.
 * Lower score = more similar.
 */
export async function searchMemory(
  query: string,
  limit = 10,
  filterKey?: string
): Promise<MemoryResult[]> {
  const table = await getTable();
  const vector = await embed(query);

  let search = table.search(vector).limit(limit);
  if (filterKey) {
    search = search.where(`key = ${JSON.stringify(filterKey)}`);
  }

  const raw = (await search.toArray()) as Array<Record<string, unknown>>;
  return raw.map((r) => rowToResult(r));
}

/**
 * Exact key lookup — no vector search.
 */
export async function getMemoryByKey(key: string): Promise<MemoryResult[]> {
  const table = await getTable();
  const rows = (await table
    .query()
    .where(`key = ${JSON.stringify(key)}`)
    .toArray()) as Array<Record<string, unknown>>;

  return rows.map((r) => rowToResult(r));
}

/**
 * Delete all rows matching a key.
 */
export async function deleteMemoryByKey(
  key: string
): Promise<{ deleted: boolean }> {
  const table = await getTable();
  await table.delete(`key = ${JSON.stringify(key)}`);
  return { deleted: true };
}
