# ironline-context-mcp — Project Context

## What This Is
MCP server providing vector memory via LanceDB Cloud. Stores embeddings using OpenAI `text-embedding-3-small` (1536 dims). Runs locally on port 3001, exposed at `/context/mcp`.

## Related Repos
- **ironline-amanda** — Amanda agent + poller. Connects to this server for semantic memory.
- **ironline-imessage-mcp** — iMessage MCP (flat-file memory tools; those will eventually migrate here)

## File Structure
```
http.ts              — HTTP MCP server (port 3001, /context/mcp)
src/tools.ts         — 4 MCP tools: memory_store, memory_search, memory_get, memory_delete
src/lancedb.ts       — LanceDB Cloud connection, table bootstrap, embed(), CRUD helpers
launchagents/        — LaunchAgent plist + install/restart scripts
```

## MCP Tools
| Tool | Description |
|------|-------------|
| `memory_store` | Upsert: embed content, write vector + metadata to LanceDB |
| `memory_search` | ANN search by query embedding, optional key filter |
| `memory_get` | Exact key lookup, no vector search |
| `memory_delete` | Delete all rows for a key |

## Running
```bash
# Install LaunchAgent (reads keys from ~/.bashrc)
bash launchagents/install.sh

# Manual
AUTH_TOKEN=<token> LANCE_DB_DEFAULT_API_KEY=<key> OPENAI_API_KEY_AMANDA_IRONLINE_AGENT=<key> bun http.ts

# Logs
tail -f ~/Library/Logs/ironline/context-mcp.log
tail -f ~/Library/Logs/ironline/context-mcp.error.log
```

## Environment Variables
- `AUTH_TOKEN` — bearer token for all requests
- `PORT` — HTTP port (default 3001)
- `LANCE_DB_DEFAULT_API_KEY` — LanceDB Cloud API key (from ~/.bashrc)
- `OPENAI_API_KEY_AMANDA_IRONLINE_AGENT` — OpenAI key for embeddings (from ~/.bashrc)

## LanceDB
- URI: `db://default-t4u99m`, Region: `us-east-1`, Project: `default`
- Table: `memories`

### Schema
```
id          string   (uuid)
key         string   (contact phone/email or topic slug)
content     string
tags        string   (JSON array, e.g. '["contact","vip"]')
vector      float32[1536]
updated_at  string   (ISO 8601)
```

## Key Technical Notes
- **Upsert = delete + insert**: LanceDB Cloud has no row-level upsert; `memory_store` deletes existing rows for a key then inserts a new one.
- **Score = `_distance`**: ANN results include `_distance` (lower = more similar). Exposed as `score` in tool output.
- **Table bootstrap**: On first run, a sentinel row is inserted and immediately deleted to establish schema. Required by LanceDB Cloud's `createTable` API.
- **Singleton connection**: `getDb()` and `getTable()` are lazily initialized once per process — first tool call pays cold-start cost.
