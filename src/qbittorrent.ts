import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, redactSecrets, fetchWithCause } from "./util.js";

interface RequestOptions {
  method?: string;
  query?: Record<string, string>;
  body?: URLSearchParams;
}

export const TORRENT_FILTERS = [
  "all",
  "downloading",
  "seeding",
  "completed",
  "stopped",
  "active",
  "inactive",
  "running",
  "stalled",
  "stalled_uploading",
  "stalled_downloading",
  "errored",
] as const;

export const DEFAULT_TORRENT_PAGE_SIZE = 25;
export const MAX_TORRENT_PAGE_SIZE = 100;

export const COMPACT_TORRENT_FIELDS = [
  "hash",
  "name",
  "state",
  "progress",
  "size",
  "amount_left",
  "dlspeed",
  "upspeed",
  "eta",
  "ratio",
  "num_seeds",
  "num_leechs",
  "connections_count",
  "trackers_count",
  "added_on",
  "completion_on",
  "category",
  "tags",
] as const;

type TorrentFilter = (typeof TORRENT_FILTERS)[number];
type TorrentRecord = Record<string, unknown>;

export interface TorrentListOptions {
  filter?: TorrentFilter;
  hashes?: string[];
  limit?: number;
  offset?: number;
  full?: boolean;
}

export interface TorrentListResult {
  torrents: TorrentRecord[];
  returned: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  mode: "compact" | "full";
}

function pageOptions(options: TorrentListOptions): {
  limit: number;
  offset: number;
} {
  const limit = options.limit ?? DEFAULT_TORRENT_PAGE_SIZE;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TORRENT_PAGE_SIZE) {
    throw new Error(
      `Torrent page limit must be an integer from 1 to ${MAX_TORRENT_PAGE_SIZE}`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Torrent page offset must be a non-negative integer");
  }
  return { limit, offset };
}

function normalizedHashes(hashes: string[] | undefined): string[] {
  if (!hashes) return [];
  if (hashes.length > MAX_TORRENT_PAGE_SIZE) {
    throw new Error(
      `At most ${MAX_TORRENT_PAGE_SIZE} torrent hashes may be requested`,
    );
  }
  const normalized = hashes.map((hash) => hash.trim());
  if (normalized.some((hash) => hash.length === 0 || hash.includes("|"))) {
    throw new Error("Torrent hashes must be non-empty and may not contain '|'");
  }
  return [...new Set(normalized)];
}

export function buildTorrentListQuery(
  options: TorrentListOptions = {},
): Record<string, string> {
  const { limit, offset } = pageOptions(options);
  const hashes = normalizedHashes(options.hashes);
  const query: Record<string, string> = {
    limit: String(limit + 1),
    offset: String(offset),
  };
  if (options.filter) query.filter = options.filter;
  if (hashes.length > 0) query.hashes = hashes.join("|");
  return query;
}

function asTorrentRecord(value: unknown): TorrentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("qBittorrent returned a malformed torrent record");
  }
  return value as TorrentRecord;
}

export function compactTorrent(value: unknown): TorrentRecord {
  const torrent = asTorrentRecord(value);
  return Object.fromEntries(
    COMPACT_TORRENT_FIELDS.map((field) => [field, torrent[field] ?? null]),
  );
}

export function formatTorrentPage(
  value: unknown,
  options: TorrentListOptions = {},
): TorrentListResult {
  if (!Array.isArray(value)) {
    throw new Error("qBittorrent returned a malformed torrent list");
  }
  const { limit, offset } = pageOptions(options);
  const records = value.map(asTorrentRecord);
  const hasMore = records.length > limit;
  const page = records.slice(0, limit);
  const torrents = options.full ? page : page.map(compactTorrent);
  return {
    torrents,
    returned: torrents.length,
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + torrents.length : null,
    mode: options.full ? "full" : "compact",
  };
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
    const res = await fetchWithCause(url, {
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

  async listTorrents(
    options: TorrentListOptions = {},
  ): Promise<TorrentListResult> {
    const torrents = await this.request("/torrents/info", {
      query: buildTorrentListQuery(options),
    });
    return formatTorrentPage(torrents, options);
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
        "List a bounded page of torrents. Returns a stable compact projection by default; use full=true only when every upstream field is needed, or qbittorrent_get_torrent for one torrent.",
      inputSchema: {
        filter: z
          .enum(TORRENT_FILTERS)
          .optional()
          .describe(`Optional status filter: ${TORRENT_FILTERS.join("|")}`),
        hashes: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .refine((hash) => !hash.includes("|"), {
                message: "Each hash must be a separate array item",
              }),
          )
          .max(MAX_TORRENT_PAGE_SIZE)
          .optional()
          .describe("Optional torrent info-hashes to select"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TORRENT_PAGE_SIZE)
          .default(DEFAULT_TORRENT_PAGE_SIZE)
          .describe("Maximum torrents to return (default 25, maximum 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Zero-based pagination offset"),
        full: z
          .boolean()
          .default(false)
          .describe(
            "Return every upstream field instead of the compact projection",
          ),
      },
    },
    async ({ filter, hashes, limit, offset, full }) =>
      asText(await qbt.listTorrents({ filter, hashes, limit, offset, full })),
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
