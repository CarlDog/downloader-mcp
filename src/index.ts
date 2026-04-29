#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { SabnzbdClient, registerSabnzbdTools } from "./sabnzbd.js";
import { QBittorrentClient, registerQbittorrentTools } from "./qbittorrent.js";

const sabUrl = process.env.SABNZBD_URL;
const sabKey = process.env.SABNZBD_API_KEY;
const sabConfig = sabUrl && sabKey ? { url: sabUrl, apiKey: sabKey } : null;

const qbtUrl = process.env.QBITTORRENT_URL;
const qbtUser = process.env.QBITTORRENT_USERNAME;
const qbtPass = process.env.QBITTORRENT_PASSWORD;
const qbtConfig =
  qbtUrl && qbtUser && qbtPass
    ? { url: qbtUrl, username: qbtUser, password: qbtPass }
    : null;

if (!sabConfig && !qbtConfig) {
  console.error("No download clients configured. Set:");
  console.error("  SABnzbd:     SABNZBD_URL + SABNZBD_API_KEY");
  console.error(
    "  qBittorrent: QBITTORRENT_URL + QBITTORRENT_USERNAME + QBITTORRENT_PASSWORD",
  );
  process.exit(1);
}

const enabled: string[] = [];
if (sabConfig) enabled.push("SABnzbd");
if (qbtConfig) enabled.push("qBittorrent");

function createServer(): McpServer {
  const server = new McpServer({
    name: "downloader-mcp",
    version: "0.1.0",
  });
  if (sabConfig) {
    registerSabnzbdTools(
      server,
      new SabnzbdClient(sabConfig.url, sabConfig.apiKey),
    );
  }
  if (qbtConfig) {
    registerQbittorrentTools(
      server,
      new QBittorrentClient(
        qbtConfig.url,
        qbtConfig.username,
        qbtConfig.password,
      ),
    );
  }
  return server;
}

console.error(`downloader-mcp: enabled = ${enabled.join(", ")}`);

const portStr = process.env.MCP_PORT;
const port = portStr ? Number.parseInt(portStr, 10) : null;
if (portStr && (port === null || Number.isNaN(port))) {
  console.error(`Invalid MCP_PORT: ${portStr}`);
  process.exit(1);
}

if (port) {
  // HTTP transport (long-lived server, e.g. for Portainer/Compose deployment).
  const httpApp = express();
  httpApp.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  httpApp.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (
        !sessionId &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: missing or unknown session, or non-initialize POST",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  httpApp.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", transport: "http", port, enabled });
  });

  httpApp.listen(port, () => {
    console.error(`downloader-mcp HTTP transport listening on :${port}`);
  });
} else {
  // Default: stdio transport (for direct invocation by MCP clients via `docker run -i`).
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
