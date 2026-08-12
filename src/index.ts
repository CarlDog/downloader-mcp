#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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

const INSTRUCTIONS = `MCP server for download clients: SABnzbd (usenet) and qBittorrent (torrents). Either client is optional — only configured ones have their tools registered. Read-only as of v1.

Idioms:
- Tools are prefixed: sabnzbd_*, qbittorrent_*. The visible set indicates which clients the user runs.
- sabnzbd_queue and qbittorrent_list_torrents are the primary "what's downloading right now" surfaces. Pair with sabnzbd_history / qbittorrent_transfer_info for completed/aggregate state.
- For qBittorrent, torrents are addressed by their info-hash (the long hex string from qbittorrent_list_torrents). Drill into a single torrent with qbittorrent_get_torrent or qbittorrent_torrent_files.
- qBittorrent auth uses session cookies internally; the MCP server handles login transparently. The first call after a long idle may trigger a re-login.

Auth: SABnzbd uses an API key (SABNZBD_API_KEY); qBittorrent uses WebUI username/password (QBITTORRENT_USERNAME / QBITTORRENT_PASSWORD).`;

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "downloader-mcp",
      version: "0.1.0",
    },
    {
      instructions: INSTRUCTIONS,
    },
  );
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

// DNS-rebinding protection (opt-in, fail-soft). When MCP_ALLOWED_HOSTS is
// set (comma-separated host[:port] list), the HTTP transport validates the
// Host header against it. When unset, behavior is unchanged so existing LAN
// deployments keep working — but we warn at startup.
const allowedHostsStr = process.env.MCP_ALLOWED_HOSTS;
const allowedHosts = allowedHostsStr
  ? allowedHostsStr
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
  : [];

// Optional shared secret for /mcp (opt-in, fail-soft, same posture as
// MCP_ALLOWED_HOSTS above). When set, every /mcp request must carry
// `Authorization: Bearer <token>`; /health stays open for the docker
// healthcheck, which can't supply one.
const authToken = process.env.MCP_AUTH_TOKEN || undefined;

function isAuthorized(req: Request): boolean {
  if (!authToken) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const presented = header.slice("Bearer ".length);
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless
  // of the presented token's length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(authToken).digest();
  return timingSafeEqual(a, b);
}

if (port) {
  // HTTP transport (long-lived server, e.g. for Portainer/Compose deployment).
  if (allowedHosts.length > 0) {
    console.error(
      `downloader-mcp: DNS-rebinding protection enabled (allowed hosts: ${allowedHosts.join(", ")})`,
    );
  } else {
    console.error(
      "downloader-mcp: MCP_ALLOWED_HOSTS not set — DNS-rebinding protection disabled. " +
        "Recommended: set it to the host names/IPs clients use (e.g. the NAS IP, host.docker.internal).",
    );
  }
  if (authToken) {
    console.error(
      "downloader-mcp: MCP_AUTH_TOKEN set — /mcp requires a bearer token.",
    );
  } else {
    console.error(
      "downloader-mcp: MCP_AUTH_TOKEN not set — /mcp accepts unauthenticated requests from " +
        "anything that can reach it. Set it unless this is a fully trusted network.",
    );
  }

  const httpApp = express();
  httpApp.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const lastActivity: Record<string, number> = {};

  // Idle-session eviction: clients that abandon a session without
  // DELETE /mcp would otherwise leave their transport + McpServer
  // resident forever. Sweep periodically and close idle sessions;
  // transport.onclose handles the map cleanup.
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, seen] of Object.entries(lastActivity)) {
      if (seen < cutoff) {
        console.error(`downloader-mcp: evicting idle session ${id}`);
        const t = transports[id];
        if (t) {
          void t.close();
        } else {
          delete lastActivity[id];
        }
      }
    }
  }, SWEEP_INTERVAL_MS).unref();

  httpApp.all("/mcp", async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Unauthorized: missing or invalid bearer token",
        },
        id: null,
      });
      return;
    }
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
        lastActivity[sessionId] = Date.now();
      } else if (
        !sessionId &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
            lastActivity[id] = Date.now();
          },
          ...(allowedHosts.length > 0
            ? { enableDnsRebindingProtection: true, allowedHosts }
            : {}),
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            delete lastActivity[transport.sessionId];
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
