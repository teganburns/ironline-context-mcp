/**
 * HTTP transport entry point for ironline-context-mcp
 *
 * Usage:
 *   AUTH_TOKEN=<secret> PORT=3001 bun http.ts
 *
 * Endpoint: POST/GET/DELETE /context/mcp
 * Auth: Authorization: Bearer <AUTH_TOKEN>
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { registerTools } from "./src/tools.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error("AUTH_TOKEN env var is required");
  process.exit(1);
}

// ── Bearer auth middleware ────────────────────────────────────────────────────

function requireBearer(req: any, res: any, next: any) {
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Server factory (one McpServer instance per session) ──────────────────────

function makeServer(): McpServer {
  const server = new McpServer({
    name: "ironline-context",
    version: "0.1.0",
  });
  registerTools(server);
  return server;
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts: ["mcp.ironline.app", "localhost", "127.0.0.1"],
});

// Active transports keyed by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/context/mcp", requireBearer, async (req: any, res: any) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await makeServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing or invalid session" },
      id: null,
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent)
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
  }
});

app.get("/context/mcp", requireBearer, async (req: any, res: any) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/context/mcp", requireBearer, async (req: any, res: any) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`ironline-context MCP server listening on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/context/mcp`);
});

process.on("SIGINT", async () => {
  for (const id in transports) {
    await transports[id].close().catch(() => {});
    delete transports[id];
  }
  process.exit(0);
});
