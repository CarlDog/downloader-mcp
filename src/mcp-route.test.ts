// Enforcement test for the Streamable HTTP session lifecycle.
//
// A session the server no longer knows MUST answer 404, never 400.
//
// The idle sweep evicts sessions on a timer, which is correct and deliberate.
// But a client only learns to recover from a 404: the spec (2025-06-18,
// Session Management §3/§4) makes it the sole defined signal — the server
// "MUST respond to requests containing that session ID with HTTP 404 Not
// Found", and on receiving one the client "MUST start a new session by
// sending a new InitializeRequest".
//
// This shipped as a blanket 400 across six fleet servers, so a routine
// 30-minute eviction read to the client as a generic protocol error and the
// connection stayed dead until a human restarted it. A comment would not have
// caught that. This does.
//
// Ported from the fleet-canonical src/shared/http-transport.test.ts, adapted
// to downloader-mcp's own contract: JSON-RPC error envelopes on every
// rejection (not the shared module's bare `{ error }`). Host/Origin matching
// itself (hostname-only, port-independent, bracketed-IPv6-aware, Origin
// required to independently match when present, checked before auth and
// before session dispatch) delegates to the fleet-canonical
// src/shared/mcp-environment.ts — see mcp-environment.test.ts for the parser
// unit tests; this file covers the route's wiring of it.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, test } from "vitest";
import { mountMcpRoute, type McpRouteOptions } from "./mcp-route.js";

const ACCEPT = "application/json, text/event-stream";
const UNKNOWN_SESSION = "00000000-0000-0000-0000-000000000000";

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-route-test", version: "0.0.0" },
  },
};

type Harness = { url: string; dispose: () => Promise<void> };

const live: Harness[] = [];

async function start(opts: Partial<McpRouteOptions> = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  const mcp = mountMcpRoute(app, "/mcp", {
    createServer: () =>
      new McpServer({ name: "mcp-route-test", version: "0.0.0" }),
    sessionIdleMs: 60_000,
    ...opts,
  });

  const harness: Harness = {
    url: `http://127.0.0.1:${port}/mcp`,
    dispose: async () => {
      await mcp.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  live.push(harness);
  return harness;
}

afterEach(async () => {
  while (live.length) await live.pop()?.dispose();
});

/** Real initialize handshake. Returns the minted session id. */
async function initialize(
  url: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...extra },
    body: JSON.stringify(INIT_BODY),
  });
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id");
  // The response is an SSE stream; release it so the socket does not linger.
  await res.body?.cancel();
  expect(id).toBeTruthy();
  return id as string;
}

/** A post-initialize request carrying whatever session id we hand it. */
function callWithSession(
  url: string,
  sessionId: string | undefined,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
}

describe("session lifecycle", () => {
  test("initialize mints a session id", async () => {
    const { url } = await start();
    expect(await initialize(url)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("an unknown session id answers 404, not 400", async () => {
    const { url } = await start();
    const res = await callWithSession(url, UNKNOWN_SESSION);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Not Found: unknown or expired session" },
      id: null,
    });
  });

  test("a session evicted by the idle sweep answers 404", async () => {
    const { url } = await start({ sessionIdleMs: 1, sweepIntervalMs: 5 });
    const id = await initialize(url);
    // Let the sweeper run at least once past the 1ms idle threshold.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const res = await callWithSession(url, id);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  test("a live session is still recognised", async () => {
    const { url } = await start();
    const id = await initialize(url);
    const res = await callWithSession(url, id);
    await res.body?.cancel();
    expect(res.status).not.toBe(404);
    expect([200, 202]).toContain(res.status);
  });

  test("a non-initialize request with no session id answers 400", async () => {
    const { url } = await start();
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: non-initialize request without a session",
      },
      id: null,
    });
  });
});

describe("hardening is unchanged", () => {
  test("missing or wrong bearer token answers 401", async () => {
    const { url } = await start({ authToken: "correct-horse" });

    const none = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(INIT_BODY),
    });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Unauthorized: missing or invalid bearer token",
      },
      id: null,
    });

    const wrong = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: "Bearer battery-staple",
      },
      body: JSON.stringify(INIT_BODY),
    });
    await wrong.body?.cancel();
    expect(wrong.status).toBe(401);
  });

  test("the correct bearer token is accepted", async () => {
    const { url } = await start({ authToken: "correct-horse" });
    expect(
      await initialize(url, { authorization: "Bearer correct-horse" }),
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("auth is checked before session handling", async () => {
    // An unknown session must not leak its 404 to an unauthenticated caller.
    const { url } = await start({ authToken: "correct-horse" });
    const res = await callWithSession(url, UNKNOWN_SESSION);
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  test("a host outside the allowlist answers 403", async () => {
    const { url } = await start({ allowedHosts: ["allowed.example"] });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
  });

  test("a bare-hostname allowlist entry matches the request regardless of port", async () => {
    // The client always dials `127.0.0.1:<ephemeral port>`; the allowlist
    // entry has no port at all. Fleet-standard MCP_ALLOWED_HOSTS contract.
    const { url } = await start({ allowedHosts: ["127.0.0.1"] });
    expect(await initialize(url)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("host check happens before session handling", async () => {
    // An unknown session must not leak its 404 to a disallowed host — the
    // 403 must win. This inverts the pre-alignment behavior, where the Host
    // check lived on the SDK transport and an unknown session never reached
    // one, so 404 won over 403.
    const { url } = await start({ allowedHosts: ["allowed.example"] });
    const res = await callWithSession(url, UNKNOWN_SESSION);
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  test("host check happens before bearer auth", async () => {
    // The cheap, no-crypto rejection should win over a 401 — Botify
    // precedent (2026-08-30). Wrong host AND wrong token: 403, not 401.
    const { url } = await start({
      allowedHosts: ["allowed.example"],
      authToken: "correct-horse",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: "Bearer battery-staple",
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  test("a present Origin must also match, even when Host is allowed", async () => {
    const { url } = await start({ allowedHosts: ["127.0.0.1"] });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        origin: "http://evil.example",
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });
});
