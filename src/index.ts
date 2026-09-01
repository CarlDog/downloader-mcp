#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express, { type Request, type Response } from "express";
import { mountMcpRoute } from "./mcp-route.js";
import { QBittorrentClient, registerQbittorrentTools } from "./qbittorrent.js";
import { SabnzbdClient, registerSabnzbdTools } from "./sabnzbd.js";
import {
  parseAllowedHosts,
  parsePositiveInteger,
} from "./shared/mcp-environment.js";
import { SERVER_VERSION } from "./version.js";

const sabUrl = process.env.SABNZBD_URL;
const sabKey = process.env.SABNZBD_API_KEY;
const sabConfig = sabUrl && sabKey ? { url: sabUrl, apiKey: sabKey } : null;

const qbtUrl = process.env.QBITTORRENT_URL;
const qbtApiKey = process.env.QBITTORRENT_API_KEY;
const qbtConfig =
  qbtUrl && qbtApiKey ? { url: qbtUrl, apiKey: qbtApiKey } : null;

if (!sabConfig && !qbtConfig) {
  console.error("No download clients configured. Set:");
  console.error("  SABnzbd:     SABNZBD_URL + SABNZBD_API_KEY");
  console.error("  qBittorrent: QBITTORRENT_URL + QBITTORRENT_API_KEY");
  process.exit(1);
}

const enabled: string[] = [];
if (sabConfig) enabled.push("SABnzbd");
if (qbtConfig) enabled.push("qBittorrent");

const INSTRUCTIONS = `MCP server for download clients: SABnzbd (usenet) and qBittorrent (torrents). Either client is optional — only configured ones have their tools registered. Reads are the default; qBittorrent exposes one deliberately constrained, confirm-gated magnet-add mutation.

Idioms:
- Tools are prefixed: sabnzbd_*, qbittorrent_*. The visible set indicates which clients the user runs.
- sabnzbd_queue and qbittorrent_list_torrents are the primary "what's downloading right now" surfaces. qbittorrent_list_torrents is compact and paginated by default; use hashes for targeted selection, limit/offset for traversal, and full=true only for deliberate bulk inspection. Pair with sabnzbd_history / qbittorrent_transfer_info for completed/aggregate state.
- For qBittorrent, torrents are addressed by their info-hash (the long hex string from qbittorrent_list_torrents). Drill into a single torrent with qbittorrent_get_torrent or qbittorrent_torrent_files.
- qbittorrent_preferences exposes a fixed diagnostic allowlist for transport, peer discovery, encryption, queueing, and proxy-routing behavior; sensitive upstream preference fields are never returned.
- qbittorrent_torrent_peers provides bounded peer diagnostics with normalized incoming/encryption/discovery evidence. Peer IP and port require include_addresses=true; stronger peer identifiers and file paths are never exposed.
- qbittorrent_add_torrent accepts one magnet URI, requires confirm=true, and adds it stopped unless start_immediately=true is explicitly requested. Treat an upstream acknowledgement as provisional unless the result says verification=present.
- qbittorrent_stop_torrents and qbittorrent_start_torrents require confirm=true and exact bounded hash lists. They reject missing targets before mutation, never support the upstream all-target shortcut, and distinguish acknowledgement from verified state.
- qBittorrent auth is a static Bearer API key on every request — no session, no login step, no cookie.

Auth: SABnzbd uses an API key (SABNZBD_API_KEY); qBittorrent uses an API key (QBITTORRENT_API_KEY, requires qBittorrent >= v5.2.0 / WebAPI >= v2.14.1 — generate it under WebUI options > API Key).`;

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "downloader-mcp",
      version: SERVER_VERSION,
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
      new QBittorrentClient(qbtConfig.url, qbtConfig.apiKey),
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

// DNS-rebinding protection. MCP_ALLOWED_HOSTS is comma-separated bare
// hostnames (hostname-only and port-independent matching; a present Origin
// header must independently match too). Malformed entries (a host:port
// authority, a scheme, a wildcard) throw at startup rather than silently
// admitting a value that can never match anything. Unset falls back to the
// safe default (localhost,127.0.0.1,[::1],host.docker.internal) — there is
// no "disabled" state anymore, only "open to whatever a real deployment
// needs, or the safe default."
const allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);

// Optional shared secret for /mcp (opt-in, fail-soft, same posture as
// MCP_ALLOWED_HOSTS above). When set, every /mcp request must carry
// `Authorization: Bearer <token>`; /health stays open for the docker
// healthcheck, which can't supply one.
const authToken = process.env.MCP_AUTH_TOKEN || undefined;

if (port) {
  // HTTP transport (long-lived server, e.g. for Portainer/Compose deployment).
  if (process.env.MCP_ALLOWED_HOSTS) {
    console.error(
      `downloader-mcp: DNS-rebinding protection enabled (allowed hosts: ${allowedHosts.join(", ")})`,
    );
  } else {
    console.error(
      `downloader-mcp: MCP_ALLOWED_HOSTS not set — falling back to the safe default (${allowedHosts.join(", ")}), which rejects a real LAN client. ` +
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

  // Idle-session eviction threshold. Env-tunable so a deployment can dial it
  // without a rebuild. This was a bare constant, so docker-compose had nothing
  // it could expose and the value was only reachable by editing source
  // (docker-deployments.md §10).
  const sessionIdleMs =
    Number.parseInt(process.env.MCP_SESSION_IDLE_MS ?? "", 10) ||
    30 * 60 * 1000;
  const rateLimitMaxRequests = parsePositiveInteger(
    "MCP_RATE_LIMIT_MAX_REQUESTS",
    process.env.MCP_RATE_LIMIT_MAX_REQUESTS,
    60,
    600,
  );

  mountMcpRoute(httpApp, "/mcp", {
    createServer,
    authToken,
    allowedHosts,
    sessionIdleMs,
    rateLimitMaxRequests,
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
