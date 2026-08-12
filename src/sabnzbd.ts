import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, redactSecrets } from "./util.js";

export class SabnzbdClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    mode: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    const url = new URL("/api", this.url);
    url.searchParams.set("mode", mode);
    url.searchParams.set("output", "json");
    url.searchParams.set("apikey", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `SABnzbd ${res.status} ${res.statusText} for mode=${mode}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as { error?: string } & Record<
      string,
      unknown
    >;
    if (json.error) {
      throw new Error(`SABnzbd error for mode=${mode}: ${json.error}`);
    }
    return redactSecrets(json) as T;
  }

  async queue(): Promise<unknown> {
    return this.request("queue");
  }

  async history(
    opts: {
      limit?: number;
      start?: number;
      search?: string;
      category?: string;
      nzoIds?: string[];
    } = {},
  ): Promise<unknown> {
    const params: Record<string, string | number> = {
      limit: opts.limit ?? 20,
    };
    if (opts.start !== undefined) params.start = opts.start;
    if (opts.search) params.search = opts.search;
    if (opts.category) params.category = opts.category;
    // SABnzbd's own history API takes nzo_ids as one comma-separated param,
    // not repeated keys — verified against a live instance.
    if (opts.nzoIds && opts.nzoIds.length > 0) {
      params.nzo_ids = opts.nzoIds.join(",");
    }
    return this.request("history", params);
  }

  async categories(): Promise<unknown> {
    return this.request("get_cats");
  }

  async version(): Promise<unknown> {
    return this.request("version");
  }
}

// Default projection for sabnzbd_history: the fields that actually answer
// "what happened to this download" without the heavy per-slot payload
// (stage_log, md5sum, meta, etc.) that pushed real requests over the tool
// timeout at modest limits. Pass full=true for the raw slot.
const HISTORY_COMPACT_FIELDS = [
  "nzo_id",
  "name",
  "category",
  "status",
  "storage",
  "bytes",
  "size",
  "time_added",
  "completed",
  "fail_message",
] as const;

function compactHistory(data: unknown): unknown {
  if (
    typeof data !== "object" ||
    data === null ||
    !("history" in data) ||
    typeof (data as { history?: unknown }).history !== "object" ||
    (data as { history?: unknown }).history === null
  ) {
    return data;
  }
  const history = (data as { history: Record<string, unknown> }).history;
  const slots = Array.isArray(history.slots) ? history.slots : [];
  const compactSlots = slots.map((slot) => {
    const out: Record<string, unknown> = {};
    if (slot && typeof slot === "object") {
      for (const field of HISTORY_COMPACT_FIELDS) {
        if (field in (slot as Record<string, unknown>)) {
          out[field] = (slot as Record<string, unknown>)[field];
        }
      }
    }
    return out;
  });
  return { history: { ...history, slots: compactSlots } };
}

export function registerSabnzbdTools(
  server: McpServer,
  sab: SabnzbdClient,
): void {
  server.registerTool(
    "sabnzbd_queue",
    {
      title: "SABnzbd: Queue",
      description:
        "Get the current SABnzbd download queue (in-progress jobs, speeds, ETAs).",
      inputSchema: {},
    },
    async () => asText(await sab.queue()),
  );

  server.registerTool(
    "sabnzbd_history",
    {
      title: "SABnzbd: History",
      description:
        "Get recent SABnzbd download history (newest first). Returns a compact field set by default (name, status, storage, bytes, etc.) — set full=true for the raw per-slot payload.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Records to return (default 20)"),
        start: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Paging offset (0-based)"),
        search: z.string().optional().describe("Filter by job name substring"),
        category: z.string().optional().describe("Filter by category"),
        nzo_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Filter to specific nzo_id(s) — the same id Radarr/Sonarr expose as downloadId, useful for checking a specific blocked/queued import",
          ),
        full: z
          .boolean()
          .optional()
          .describe(
            "Return the full raw slot payload instead of the compact field set (default false)",
          ),
      },
    },
    async ({ limit, start, search, category, nzo_ids, full }) => {
      const data = await sab.history({
        limit,
        start,
        search,
        category,
        nzoIds: nzo_ids,
      });
      return asText(full ? data : compactHistory(data));
    },
  );

  server.registerTool(
    "sabnzbd_categories",
    {
      title: "SABnzbd: Categories",
      description: "List configured SABnzbd categories.",
      inputSchema: {},
    },
    async () => asText(await sab.categories()),
  );

  server.registerTool(
    "sabnzbd_version",
    {
      title: "SABnzbd: Version",
      description: "Get SABnzbd version info.",
      inputSchema: {},
    },
    async () => asText(await sab.version()),
  );
}
