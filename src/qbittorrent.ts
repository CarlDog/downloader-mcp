import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, redactSecrets } from "./util.js";

interface RequestOptions {
  method?: string;
  query?: Record<string, string>;
  body?: URLSearchParams;
}

export class QBittorrentClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`/api/v2${path}`, this.url);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (options.body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(url, {
      method: options.method ?? "GET",
      body: options.body,
      headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `qBittorrent ${res.status} ${res.statusText} for ${path}: ${body.slice(0, 200)}`,
      );
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      return redactSecrets(await res.json()) as T;
    }
    return redactSecrets(await res.text()) as unknown as T;
  }

  async listTorrents(filter?: string): Promise<unknown> {
    return this.request("/torrents/info", {
      query: filter ? { filter } : {},
    });
  }

  async getTorrent(hash: string): Promise<unknown> {
    const list = await this.request<unknown[]>("/torrents/info", {
      query: { hashes: hash },
    });
    return Array.isArray(list) ? (list[0] ?? null) : null;
  }

  async torrentFiles(hash: string): Promise<unknown> {
    return this.request("/torrents/files", { query: { hash } });
  }

  async transferInfo(): Promise<unknown> {
    return this.request("/transfer/info");
  }

  async categories(): Promise<unknown> {
    return this.request("/torrents/categories");
  }

  async version(): Promise<unknown> {
    return this.request("/app/version");
  }
}

export function registerQbittorrentTools(
  server: McpServer,
  qbt: QBittorrentClient,
): void {
  server.registerTool(
    "qbittorrent_list_torrents",
    {
      title: "qBittorrent: List Torrents",
      description:
        "List torrents, optionally filtered by status (all, downloading, completed, paused, active, inactive, resumed).",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe(
            "Optional status filter: all|downloading|completed|paused|active|inactive|resumed",
          ),
      },
    },
    async ({ filter }) => asText(await qbt.listTorrents(filter)),
  );

  server.registerTool(
    "qbittorrent_get_torrent",
    {
      title: "qBittorrent: Get Torrent",
      description: "Get details for a single torrent by info-hash.",
      inputSchema: {
        hash: z.string().describe("The torrent info-hash"),
      },
    },
    async ({ hash }) => asText(await qbt.getTorrent(hash)),
  );

  server.registerTool(
    "qbittorrent_torrent_files",
    {
      title: "qBittorrent: Torrent Files",
      description: "List the files inside a torrent.",
      inputSchema: {
        hash: z.string().describe("The torrent info-hash"),
      },
    },
    async ({ hash }) => asText(await qbt.torrentFiles(hash)),
  );

  server.registerTool(
    "qbittorrent_transfer_info",
    {
      title: "qBittorrent: Transfer Info",
      description:
        "Get global transfer statistics (current speeds, totals, connection state).",
      inputSchema: {},
    },
    async () => asText(await qbt.transferInfo()),
  );

  server.registerTool(
    "qbittorrent_categories",
    {
      title: "qBittorrent: Categories",
      description: "List configured qBittorrent categories.",
      inputSchema: {},
    },
    async () => asText(await qbt.categories()),
  );

  server.registerTool(
    "qbittorrent_version",
    {
      title: "qBittorrent: Version",
      description: "Get qBittorrent application version.",
      inputSchema: {},
    },
    async () => asText(await qbt.version()),
  );
}
