// The Streamable HTTP `/mcp` route: Host allowlist, bearer auth, per-session
// transport map, idle-session sweep, and session dispatch.
//
// Extracted from index.ts purely to create a test seam. index.ts self-executes
// on import — it either starts a listener or connects stdio at module scope,
// and exits(1) when no download client is configured — so while this logic
// lived inline in an `if (port) { ... }` block there was nothing importable,
// and the session-status rules below could only be checked by hand against a
// running build. Behavior is unchanged from the inline version; see
// mcp-route.test.ts for what is now pinned.
//
// Still NOT sharing the fleet-canonical src/shared/http-transport.ts wholesale
// (this route keeps JSON-RPC error envelopes on every rejection, not the
// shared module's bare `{ error }` body — a real response-shape difference).
// Host checking, however, is now hand-rolled middleware here instead of being
// delegated to the SDK transport's `enableDnsRebindingProtection`: the SDK
// (1.30.0) does an exact match on the full raw `Host` header including the
// port (`_allowedHosts.includes(hostHeader)`, see
// node_modules/@modelcontextprotocol/sdk .../webStandardStreamableHttp.js),
// so a bare hostname entry could never match a real `host:port` request — the
// same bug Botify's 2026-08-30 fix closed by moving off the SDK's check
// entirely. Host matching is now hostname-only and port-independent, via the
// same URL-authority parser plex-mcp and plex-companion use, and runs before
// bearer auth (the cheaper, no-crypto check first — Botify precedent).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Express, Request, Response } from "express";

/**
 * Extract the hostname portion of a `Host`-header-style authority string,
 * independent of any port suffix. Uses URL parsing (not a colon-split) so
 * bracketed IPv6 (`[::1]:3009`) resolves to `[::1]`, not the mangled `[` a
 * naive split produces — see plex-companion's 2026-08-30 IPv6 fix, which this
 * mirrors. Returns undefined for anything that isn't a bare authority (a
 * userinfo, path, query, or fragment component means the header was not a
 * plain host[:port] value).
 */
export function hostnameFromAuthority(
  value: string | undefined,
): string | undefined {
  try {
    const authority = new URL(`http://${value ?? ""}`);
    if (
      authority.username ||
      authority.password ||
      authority.pathname !== "/" ||
      authority.search ||
      authority.hash
    ) {
      return undefined;
    }
    return authority.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export interface McpRouteOptions {
  /**
   * Builds a NEW McpServer with every tool registered.
   *
   * Must be a factory, not a shared instance: one McpServer reused across
   * HTTP sessions breaks after the first — and it works fine under stdio, so
   * light testing never catches it.
   */
  createServer: () => McpServer;
  /**
   * Shared secret for `/mcp`. When set, every request must carry
   * `Authorization: Bearer <token>`. Unset leaves the route open (fail-soft,
   * warned at startup).
   */
  authToken?: string | undefined;
  /**
   * `Host` header hostnames accepted, matched case-insensitively and
   * independent of port (e.g. `your-nas`; bracketed IPv6 like `[::1]` is
   * supported). A `host:port` entry also works — the port is ignored — so an
   * old-style deployed value keeps matching unchanged. Enforced by hand-rolled
   * middleware ahead of bearer auth and session dispatch. Empty leaves the
   * protection off (fail-soft, warned at startup).
   */
  allowedHosts?: string[] | undefined;
  sessionIdleMs: number;
  /** Sweep cadence. Defaults to 5 minutes. */
  sweepIntervalMs?: number;
}

/**
 * Mount the MCP Streamable HTTP endpoint on an Express app.
 *
 * Returns a dispose() that clears the sweep timer and closes live sessions, so
 * tests and graceful shutdown don't leak handles.
 */
export function mountMcpRoute(
  app: Express,
  path: string,
  opts: McpRouteOptions,
): { dispose: () => Promise<void> } {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const lastActivity: Record<string, number> = {};
  // Normalized once at mount time, not per-request: strips a port suffix off
  // each configured entry too, so a deployed value that still says
  // `your-nas:3003` (the pre-alignment format) keeps matching without an env
  // change.
  const normalizedAllowedHosts = (opts.allowedHosts ?? []).map(
    (h) => hostnameFromAuthority(h) ?? h.toLowerCase(),
  );

  function isHostAllowed(req: Request): boolean {
    if (normalizedAllowedHosts.length === 0) return true; // not configured: open
    const host = hostnameFromAuthority(req.headers.host);
    return host !== undefined && normalizedAllowedHosts.includes(host);
  }

  function isAuthorized(req: Request): boolean {
    if (!opts.authToken) return true;
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return false;
    }
    const presented = header.slice("Bearer ".length);
    // Hash both sides so timingSafeEqual gets equal-length buffers regardless
    // of the presented token's length.
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(opts.authToken).digest();
    return timingSafeEqual(a, b);
  }

  // Idle-session eviction: clients that abandon a session without
  // DELETE /mcp would otherwise leave their transport + McpServer
  // resident forever. Sweep periodically and close idle sessions;
  // transport.onclose handles the map cleanup.
  const sweepIntervalMs = opts.sweepIntervalMs ?? 5 * 60 * 1000;
  const sweep = setInterval(() => {
    const cutoff = Date.now() - opts.sessionIdleMs;
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
  }, sweepIntervalMs);
  sweep.unref();

  app.all(path, async (req: Request, res: Response) => {
    // Host check first: the cheap, no-crypto rejection should happen before
    // any auth work (Botify precedent, 2026-08-30).
    if (!isHostAllowed(req)) {
      console.error(
        `downloader-mcp: rejected request with disallowed Host header: ${req.headers.host}`,
      );
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden: host not allowed" },
        id: null,
      });
      return;
    }
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
          // No enableDnsRebindingProtection/allowedHosts here — Host
          // checking now happens in isHostAllowed() above, before this
          // transport is even reached. The SDK's own check does an exact
          // match on the raw Host header including the port, which the
          // hand-rolled check deliberately does not.
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            delete lastActivity[transport.sessionId];
          }
        };
        const server = opts.createServer();
        await server.connect(transport);
      } else if (sessionId) {
        // A session id we don't recognise: evicted by the idle sweep, or the
        // process restarted under a live client. The spec REQUIRES 404 here —
        // it is the client's ONLY defined signal to start a new session by
        // re-initializing (2025-06-18, Session Management §3/§4). A 400 reads
        // as a generic protocol error, so the client stays wedged until a
        // human restarts it: a routine eviction becomes a dead connection.
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Found: unknown or expired session",
          },
          id: null,
        });
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: non-initialize request without a session",
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

  return {
    dispose: async () => {
      clearInterval(sweep);
      await Promise.all(
        Object.values(transports).map((t) =>
          t.close().catch(() => {
            /* already gone; nothing to release */
          }),
        ),
      );
    },
  };
}
