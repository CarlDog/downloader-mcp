import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, redactSecrets, fetchWithCause } from "./util.js";

interface RequestOptions {
  method?: string;
  query?: Record<string, string>;
  body?: URLSearchParams | FormData;
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
export const MAX_MAGNET_URI_LENGTH = 8192;
export const DEFAULT_PEER_PAGE_SIZE = 25;
export const MAX_PEER_PAGE_SIZE = 100;
export const MAX_TORRENT_STATE_TARGETS = 100;

export const DIAGNOSTIC_PREFERENCE_FIELDS = [
  "add_stopped_enabled",
  "start_paused_enabled",
  "dht",
  "pex",
  "lsd",
  "encryption",
  "anonymous_mode",
  "bittorrent_protocol",
  "listen_port",
  "upnp",
  "random_port",
  "current_network_interface",
  "current_interface_name",
  "proxy_type",
  "proxy_bittorrent",
  "proxy_peer_connections",
  "proxy_hostname_lookup",
  "queueing_enabled",
  "max_active_downloads",
  "max_active_uploads",
  "max_active_torrents",
  "dl_limit",
  "up_limit",
  "alt_dl_limit",
  "alt_up_limit",
  "limit_utp_rate",
  "limit_tcp_overhead",
  "limit_lan_peers",
  "ssrf_mitigation",
  "validate_https_tracker_certificate",
  "resolve_peer_countries",
] as const;

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

export interface TorrentPeerOptions {
  limit?: number;
  offset?: number;
  includeAddresses?: boolean;
}

export interface TorrentPeerPage {
  peers: TorrentRecord[];
  returned: number;
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  addresses_included: boolean;
  response_id: number | null;
  full_update: boolean | null;
}

export type TorrentStateAction = "stop" | "start";

export interface TorrentStateVerification {
  observed: Array<{ hash: string; state: string | null }>;
  missing_hashes: string[];
  verified: boolean;
}

export interface TorrentStateChangeResult extends TorrentStateVerification {
  action: TorrentStateAction;
  requested: number;
  upstream_acknowledged: true;
  warning: string | null;
}

export interface ParsedMagnetUri {
  uri: string;
  expectedInfoHash: string | null;
}

export interface TorrentAddOptions {
  category?: string;
  startImmediately?: boolean;
}

export interface TorrentAddResult {
  added: boolean;
  preexisting: boolean;
  started_immediately: boolean;
  expected_info_hash: string | null;
  upstream_status: "acknowledged" | "rejected" | "unknown";
  upstream_counts: {
    success: number | null;
    pending: number | null;
    failure: number | null;
  };
  verification:
    "preexisting" | "present" | "not_observed" | "not_possible" | "unavailable";
  torrent: TorrentRecord | null;
  warning: string | null;
}

export interface TorrentAddAcknowledgement {
  status: "acknowledged" | "rejected" | "unknown";
  counts: {
    success: number | null;
    pending: number | null;
    failure: number | null;
  };
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

export function parseMagnetUri(value: string): ParsedMagnetUri {
  const uri = value.trim();
  if (uri.length === 0 || uri.length > MAX_MAGNET_URI_LENGTH) {
    throw new Error(
      `Magnet URI must contain 1 to ${MAX_MAGNET_URI_LENGTH} characters`,
    );
  }
  if (/[\r\n]/u.test(uri)) {
    throw new Error("Magnet URI may not contain line breaks");
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("A valid magnet URI is required");
  }
  if (parsed.protocol.toLowerCase() !== "magnet:") {
    throw new Error("Only magnet URIs are accepted");
  }

  const exactTopics = parsed.searchParams.getAll("xt");
  const btih = exactTopics.find((topic) =>
    /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/iu.test(topic),
  );
  const btmh = exactTopics.find((topic) =>
    /^urn:btmh:1220[0-9a-f]{64}$/iu.test(topic),
  );
  if (!btih && !btmh) {
    throw new Error(
      "Magnet URI must contain a valid BitTorrent v1 or v2 exact topic",
    );
  }

  const hexHash = btih?.match(/^urn:btih:([0-9a-f]{40})$/iu)?.[1];
  return {
    uri,
    expectedInfoHash: hexHash?.toLowerCase() ?? null,
  };
}

function normalizedCategory(category: string | undefined): string | undefined {
  if (category === undefined) return undefined;
  const normalized = category.trim();
  if (normalized.length === 0 || normalized.length > 100) {
    throw new Error("Category must contain 1 to 100 characters");
  }
  if (
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error("Category may not contain control characters");
  }
  return normalized;
}

export function buildAddTorrentForm(
  magnetUri: string,
  options: TorrentAddOptions = {},
): FormData {
  const magnet = parseMagnetUri(magnetUri);
  const category = normalizedCategory(options.category);
  const form = new FormData();
  form.set("urls", magnet.uri);
  form.set("paused", options.startImmediately === true ? "false" : "true");
  if (category) form.set("category", category);
  return form;
}

function finiteCount(
  value: Record<string, unknown>,
  field: string,
): number | null {
  const count = value[field];
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

export function summarizeAddAcknowledgement(
  value: unknown,
): TorrentAddAcknowledgement {
  const counts = { success: null, pending: null, failure: null } as {
    success: number | null;
    pending: number | null;
    failure: number | null;
  };
  if (typeof value === "string") {
    const response = value.trim();
    if (/^fails?\.?$/iu.test(response)) return { status: "rejected", counts };
    if (/^ok\.?$/iu.test(response)) return { status: "acknowledged", counts };
    return { status: "unknown", counts };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "unknown", counts };
  }

  const record = value as Record<string, unknown>;
  counts.success = finiteCount(record, "success_count");
  counts.pending = finiteCount(record, "pending_count");
  counts.failure = finiteCount(record, "failure_count");
  const accepted = (counts.success ?? 0) + (counts.pending ?? 0);
  if (accepted > 0) return { status: "acknowledged", counts };
  if ((counts.failure ?? 0) > 0) return { status: "rejected", counts };
  return { status: "unknown", counts };
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

export function projectDiagnosticPreferences(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("qBittorrent returned malformed application preferences");
  }
  const preferences = value as Record<string, unknown>;
  const projected = Object.fromEntries(
    DIAGNOSTIC_PREFERENCE_FIELDS.map((field) => [
      field,
      preferences[field] ?? null,
    ]),
  );
  const encryption = preferences.encryption;
  projected.encryption_mode =
    encryption === 0
      ? "allow"
      : encryption === 1
        ? "require"
        : encryption === 2
          ? "disable"
          : null;
  return projected;
}

function peerPageOptions(options: TorrentPeerOptions): {
  limit: number;
  offset: number;
} {
  const limit = options.limit ?? DEFAULT_PEER_PAGE_SIZE;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PEER_PAGE_SIZE) {
    throw new Error(
      `Peer page limit must be an integer from 1 to ${MAX_PEER_PAGE_SIZE}`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Peer page offset must be a non-negative integer");
  }
  return { limit, offset };
}

function peerFlagTokens(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set(value.split(/\s+/u).filter((flag) => flag.length > 0));
}

export function compactTorrentPeer(
  value: unknown,
  includeAddresses = false,
): TorrentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("qBittorrent returned a malformed peer record");
  }
  const peer = value as TorrentRecord;
  const flags = typeof peer.flags === "string" ? peer.flags : "";
  const tokens = peerFlagTokens(flags);
  const sources: string[] = [];
  if (tokens.has("H")) sources.push("dht");
  if (tokens.has("X")) sources.push("pex");
  if (tokens.has("L")) sources.push("lsd");
  const compact: TorrentRecord = {
    client: peer.client ?? null,
    progress: peer.progress ?? null,
    dl_speed: peer.dl_speed ?? null,
    up_speed: peer.up_speed ?? null,
    downloaded: peer.downloaded ?? null,
    uploaded: peer.uploaded ?? null,
    connection: peer.connection ?? null,
    flags,
    incoming: tokens.has("I"),
    encryption: tokens.has("E")
      ? "traffic"
      : tokens.has("e")
        ? "handshake"
        : "not_reported",
    sources,
    country: peer.country ?? null,
    country_code: peer.country_code ?? null,
  };
  if (includeAddresses) {
    compact.address = {
      ip: peer.ip ?? null,
      port: peer.port ?? null,
    };
  }
  return compact;
}

export function formatTorrentPeerPage(
  value: unknown,
  options: TorrentPeerOptions = {},
): TorrentPeerPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("qBittorrent returned a malformed peer response");
  }
  const response = value as Record<string, unknown>;
  const peersValue = response.peers;
  if (
    typeof peersValue !== "object" ||
    peersValue === null ||
    Array.isArray(peersValue)
  ) {
    throw new Error("qBittorrent returned a malformed peer map");
  }

  const { limit, offset } = peerPageOptions(options);
  const entries = Object.entries(peersValue).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const page = entries
    .slice(offset, offset + limit)
    .map(([, peer]) => compactTorrentPeer(peer, options.includeAddresses));
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < entries.length;
  return {
    peers: page,
    returned: page.length,
    total: entries.length,
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null,
    addresses_included: options.includeAddresses === true,
    response_id:
      typeof response.rid === "number" && Number.isInteger(response.rid)
        ? response.rid
        : null,
    full_update:
      typeof response.full_update === "boolean" ? response.full_update : null,
  };
}

function normalizedTorrentHash(hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) {
    throw new Error("Torrent hash must be 40 or 64 hexadecimal characters");
  }
  return normalized;
}

export function buildTorrentStateChangeRequest(
  action: TorrentStateAction,
  hashes: string[],
): { path: string; body: URLSearchParams; hashes: string[] } {
  if (hashes.length < 1 || hashes.length > MAX_TORRENT_STATE_TARGETS) {
    throw new Error(
      `State changes require 1 to ${MAX_TORRENT_STATE_TARGETS} torrent hashes`,
    );
  }
  const normalized = [
    ...new Set(hashes.map((hash) => normalizedTorrentHash(hash))),
  ];
  const body = new URLSearchParams();
  body.set("hashes", normalized.join("|"));
  return { path: `/torrents/${action}`, body, hashes: normalized };
}

function stateMatchesAction(
  action: TorrentStateAction,
  state: string | null,
): boolean {
  if (state === null) return false;
  const stopped = /^(?:stopped|paused)/u.test(state.toLowerCase());
  return action === "stop" ? stopped : !stopped;
}

export function verifyTorrentStates(
  action: TorrentStateAction,
  requestedHashes: string[],
  torrents: unknown,
): TorrentStateVerification {
  if (!Array.isArray(torrents)) {
    throw new Error("qBittorrent returned a malformed state-verification list");
  }
  const byHash = new Map<string, string | null>();
  for (const value of torrents) {
    const torrent = asTorrentRecord(value);
    if (typeof torrent.hash !== "string") {
      throw new Error("qBittorrent returned a torrent without a hash");
    }
    byHash.set(
      torrent.hash.toLowerCase(),
      typeof torrent.state === "string" ? torrent.state : null,
    );
  }
  const observed = requestedHashes
    .filter((hash) => byHash.has(hash))
    .map((hash) => ({ hash, state: byHash.get(hash) ?? null }));
  const missingHashes = requestedHashes.filter((hash) => !byHash.has(hash));
  return {
    observed,
    missing_hashes: missingHashes,
    verified:
      missingHashes.length === 0 &&
      observed.every(({ state }) => stateMatchesAction(action, state)),
  };
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
    if (options.body instanceof URLSearchParams) {
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

  async preferences(): Promise<Record<string, unknown>> {
    return projectDiagnosticPreferences(await this.request("/app/preferences"));
  }

  async torrentPeers(
    hash: string,
    options: TorrentPeerOptions = {},
  ): Promise<TorrentPeerPage> {
    const response = await this.request("/sync/torrentPeers", {
      query: { hash: normalizedTorrentHash(hash), rid: "0" },
    });
    return formatTorrentPeerPage(response, options);
  }

  async changeTorrentState(
    action: TorrentStateAction,
    hashes: string[],
  ): Promise<TorrentStateChangeResult> {
    const request = buildTorrentStateChangeRequest(action, hashes);
    const before = await this.listTorrents({
      hashes: request.hashes,
      limit: request.hashes.length,
    });
    const beforeHashes = new Set(
      before.torrents
        .map((torrent) => torrent.hash)
        .filter((hash): hash is string => typeof hash === "string")
        .map((hash) => hash.toLowerCase()),
    );
    const missingBefore = request.hashes.filter(
      (hash) => !beforeHashes.has(hash),
    );
    if (missingBefore.length > 0) {
      throw new Error(
        `Refusing a partial ${action}: ${missingBefore.length} of ${request.hashes.length} requested torrent hashes do not exist`,
      );
    }

    await this.request(request.path, {
      method: "POST",
      body: request.body,
    });

    try {
      const after = await this.listTorrents({
        hashes: request.hashes,
        limit: request.hashes.length,
      });
      const verification = verifyTorrentStates(
        action,
        request.hashes,
        after.torrents,
      );
      return {
        action,
        requested: request.hashes.length,
        upstream_acknowledged: true,
        ...verification,
        warning: verification.verified
          ? null
          : "qBittorrent acknowledged the request, but the immediate state read did not verify every target; inspect the returned states before relying on completion.",
      };
    } catch {
      return {
        action,
        requested: request.hashes.length,
        upstream_acknowledged: true,
        observed: [],
        missing_hashes: [],
        verified: false,
        warning:
          "qBittorrent acknowledged the request, but post-change verification was unavailable.",
      };
    }
  }

  async version(): Promise<unknown> {
    return this.request("/app/version");
  }

  async addTorrent(
    magnetUri: string,
    options: TorrentAddOptions = {},
  ): Promise<TorrentAddResult> {
    const magnet = parseMagnetUri(magnetUri);
    const startedImmediately = options.startImmediately === true;
    const preexisting = magnet.expectedInfoHash
      ? await this.getTorrent(magnet.expectedInfoHash)
      : null;
    if (preexisting) {
      return {
        added: false,
        preexisting: true,
        started_immediately: startedImmediately,
        expected_info_hash: magnet.expectedInfoHash,
        upstream_status: "unknown",
        upstream_counts: { success: null, pending: null, failure: null },
        verification: "preexisting",
        torrent: compactTorrent(preexisting),
        warning: "The torrent already existed, so no add request was sent.",
      };
    }

    const response = await this.request("/torrents/add", {
      method: "POST",
      body: buildAddTorrentForm(magnet.uri, options),
    });
    const acknowledgement = summarizeAddAcknowledgement(response);
    let verification: TorrentAddResult["verification"] = magnet.expectedInfoHash
      ? "not_observed"
      : "not_possible";
    let torrent: TorrentRecord | null = null;
    if (magnet.expectedInfoHash && acknowledgement.status !== "rejected") {
      try {
        const observed = await this.getTorrent(magnet.expectedInfoHash);
        if (observed) {
          torrent = compactTorrent(observed);
          verification = "present";
        }
      } catch {
        verification = "unavailable";
      }
    }

    const added =
      acknowledgement.status !== "rejected" && verification === "present";
    const warning =
      verification === "present"
        ? null
        : acknowledgement.status === "rejected"
          ? "qBittorrent rejected the add request."
          : "qBittorrent did not prove that the torrent was added; verify with qbittorrent_list_torrents before relying on it.";
    return {
      added,
      preexisting: false,
      started_immediately: startedImmediately,
      expected_info_hash: magnet.expectedInfoHash,
      upstream_status: acknowledgement.status,
      upstream_counts: acknowledgement.counts,
      verification,
      torrent,
      warning,
    };
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
    "qbittorrent_preferences",
    {
      title: "qBittorrent: Diagnostic Preferences",
      description:
        "Get a fixed, non-sensitive projection of qBittorrent transport, discovery, encryption, proxy-routing, queue, and rate-limit preferences. Credential, filesystem-path, host-address, notification, and WebUI fields are always omitted; there is intentionally no full-output mode.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => asText(await qbt.preferences()),
  );

  server.registerTool(
    "qbittorrent_torrent_peers",
    {
      title: "qBittorrent: Torrent Peers",
      description:
        "List a bounded deterministic page of connected peers for one torrent, including client, transfer activity, transport, incoming direction, encryption evidence, and discovery source. IP address and port are omitted by default and require include_addresses=true; hostnames, peer IDs, I2P destinations, and file paths are never returned.",
      inputSchema: {
        hash: z
          .string()
          .trim()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
          .describe("The torrent's 40- or 64-character hexadecimal hash"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PEER_PAGE_SIZE)
          .default(DEFAULT_PEER_PAGE_SIZE)
          .describe("Maximum peers to return (default 25, maximum 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Zero-based offset in the deterministic peer ordering"),
        include_addresses: z
          .boolean()
          .default(false)
          .describe(
            "Explicitly include each peer's potentially sensitive IP address and port",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ hash, limit, offset, include_addresses }) =>
      asText(
        await qbt.torrentPeers(hash, {
          limit,
          offset,
          includeAddresses: include_addresses,
        }),
      ),
  );

  const stateChangeInputSchema = {
    hashes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu),
      )
      .min(1)
      .max(MAX_TORRENT_STATE_TARGETS)
      .describe(
        "Exact torrent hashes only; bulk 'all' targeting is intentionally unsupported",
      ),
    confirm: z
      .literal(true)
      .describe("Must be true to authorize the requested state change"),
  };

  server.registerTool(
    "qbittorrent_stop_torrents",
    {
      title: "qBittorrent: Stop Torrents",
      description:
        "Stop 1–100 explicitly identified torrents. Requires confirm=true, rejects missing targets before mutation, never accepts the qBittorrent 'all' shortcut, and reports post-change state verification separately from HTTP acknowledgement.",
      inputSchema: stateChangeInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ hashes, confirm }) => {
      if (confirm !== true) {
        throw new Error("confirm=true is required to stop torrents");
      }
      return asText(await qbt.changeTorrentState("stop", hashes));
    },
  );

  server.registerTool(
    "qbittorrent_start_torrents",
    {
      title: "qBittorrent: Start Torrents",
      description:
        "Start 1–100 explicitly identified torrents. Requires confirm=true because it can initiate network and disk activity, rejects missing targets before mutation, never accepts the qBittorrent 'all' shortcut, and reports post-change state verification separately from HTTP acknowledgement.",
      inputSchema: stateChangeInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ hashes, confirm }) => {
      if (confirm !== true) {
        throw new Error("confirm=true is required to start torrents");
      }
      return asText(await qbt.changeTorrentState("start", hashes));
    },
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

  server.registerTool(
    "qbittorrent_add_torrent",
    {
      title: "qBittorrent: Add Torrent",
      description:
        "Add one validated magnet URI. Requires confirm=true and adds the torrent stopped by default; set start_immediately=true only when download activity should begin immediately. Remote torrent URLs, arbitrary save paths, and bulk input are intentionally unsupported.",
      inputSchema: {
        magnet_uri: z
          .string()
          .trim()
          .min(1)
          .max(MAX_MAGNET_URI_LENGTH)
          .describe("A BitTorrent v1, v2, or hybrid magnet URI"),
        category: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Optional existing qBittorrent category"),
        start_immediately: z
          .boolean()
          .default(false)
          .describe("Start downloading immediately instead of adding stopped"),
        confirm: z
          .literal(true)
          .describe("Must be true to authorize this persistent mutation"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ magnet_uri, category, start_immediately, confirm }) => {
      if (confirm !== true) {
        throw new Error("confirm=true is required to add a torrent");
      }
      return asText(
        await qbt.addTorrent(magnet_uri, {
          category,
          startImmediately: start_immediately,
        }),
      );
    },
  );
}
