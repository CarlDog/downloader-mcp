#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SabnzbdClient, registerSabnzbdTools } from "./sabnzbd.js";
import {
  QBittorrentClient,
  registerQbittorrentTools,
} from "./qbittorrent.js";

const server = new McpServer({
  name: "downloader-mcp",
  version: "0.1.0",
});

const enabled: string[] = [];

const sabUrl = process.env.SABNZBD_URL;
const sabKey = process.env.SABNZBD_API_KEY;
if (sabUrl && sabKey) {
  registerSabnzbdTools(server, new SabnzbdClient(sabUrl, sabKey));
  enabled.push("SABnzbd");
}

const qbtUrl = process.env.QBITTORRENT_URL;
const qbtUser = process.env.QBITTORRENT_USERNAME;
const qbtPass = process.env.QBITTORRENT_PASSWORD;
if (qbtUrl && qbtUser && qbtPass) {
  registerQbittorrentTools(
    server,
    new QBittorrentClient(qbtUrl, qbtUser, qbtPass),
  );
  enabled.push("qBittorrent");
}

if (enabled.length === 0) {
  console.error("No download clients configured. Set:");
  console.error("  SABnzbd:     SABNZBD_URL + SABNZBD_API_KEY");
  console.error(
    "  qBittorrent: QBITTORRENT_URL + QBITTORRENT_USERNAME + QBITTORRENT_PASSWORD",
  );
  process.exit(1);
}

console.error(`downloader-mcp: enabled = ${enabled.join(", ")}`);

await server.connect(new StdioServerTransport());
