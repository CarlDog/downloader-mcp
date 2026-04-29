import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "./util.js";

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
    return json as T;
  }

  async queue(): Promise<unknown> {
    return this.request("queue");
  }

  async history(limit = 20): Promise<unknown> {
    return this.request("history", { limit });
  }

  async categories(): Promise<unknown> {
    return this.request("get_cats");
  }

  async version(): Promise<unknown> {
    return this.request("version");
  }
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
      description: "Get recent SABnzbd download history (newest first).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Records to return (default 20)"),
      },
    },
    async ({ limit }) => asText(await sab.history(limit)),
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
