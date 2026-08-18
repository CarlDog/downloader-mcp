# downloader-mcp

MCP server for download clients (SABnzbd, qBittorrent), packaged as a
Docker container. Designed as a companion to media-management MCPs
like `servarr-mcp`.

## Status

Single source of truth: [STATUS.md](STATUS.md). Do not duplicate status
into this file, MEMORY.md, or Serena memories — reference STATUS.md.

## Current Sprint

**Phase: deployed and verified (NAS)** — see [STATUS.md](STATUS.md) for the active
phase, what's done, and what's next.

## Stack

- TypeScript (Node 22+, ESM, `NodeNext` module resolution)
- `@modelcontextprotocol/sdk` (high-level `McpServer` API)
- `zod` for tool input schemas
- Each client uses its own auth/HTTP shape (no shared base — see below)
- Docker multi-stage build (alpine, non-root user `mcp`)

## Why no shared base class

Unlike `servarr-mcp` (where Sonarr/Radarr/Lidarr/Readarr/Prowlarr share
a v1/v3 REST + `X-Api-Key` shape), SABnzbd and qBittorrent have nothing
in common at the API layer:

- **SABnzbd**: query-string GET API (`/api?mode=queue&apikey=X&output=json`).
  Single endpoint, mode-driven dispatch.
- **qBittorrent**: REST-ish (`/api/v2/...`) with a static
  `Authorization: Bearer <API key>` header on every request.

Each client is fully self-contained in its own file. Adding a third
client (Deluge, Transmission, NZBGet, etc.) means a new file and a new
optional registration in `src/index.ts` — no inheritance refactor.

## Layout

- `src/index.ts` — MCP server entry. Computes which clients are enabled
  from env vars at startup, then decides transport (stdio vs HTTP)
  based on `MCP_PORT`. Per-session `McpServer` instances via the
  `createServer()` factory.
- `src/mcp-route.ts` — the Streamable HTTP `/mcp` route: bearer auth,
  per-session transport map, idle sweep, session dispatch. Split out of
  `index.ts` so it can be imported by a test — `index.ts` self-executes on
  import (and `exit(1)`s with no client configured), so nothing in it was
  reachable without booting a server. Covered by `src/mcp-route.test.ts`.
- `src/util.ts` — single `asText()` helper used by both clients.
- `src/sabnzbd.ts` — `SabnzbdClient` + `registerSabnzbdTools`.
- `src/qbittorrent.ts` — `QBittorrentClient` (static Bearer API-key
  auth) + `registerQbittorrentTools`.
- `Dockerfile` — multi-stage build (alpine, non-root user).
- `docker-compose.yml` — Compose/Portainer deployment using HTTP transport.
- `.githooks/pre-commit` — gitleaks + PII pattern scan.

## When to add a `tools/` layer

Today each client's API class and its MCP tool registrations live in
the same file (`src/sabnzbd.ts`, `src/qbittorrent.ts`). That's
idiomatic when each tool is a thin wrapper over a single API call.

**Trigger to refactor:** the first tool that doesn't fit cleanly in any
existing client file. Concretely:

- A tool that **orchestrates across both clients** — e.g. a unified
  "downloads_summary" that merges SABnzbd queue + qBittorrent torrents
  into one normalized view.
- A tool that does **non-trivial composition** of multiple upstream
  calls — cross-references, ranking, filtering beyond what either
  API exposes natively.

When that moment arrives:

1. Create `src/tools/<descriptive-name>.ts` for the cross-cutting tool.
2. Pull existing per-client `register<Client>Tools` functions into
   `src/tools/<client>.ts` for symmetry. Each `src/<client>.ts` then
   holds just the client class.
3. Mechanical refactor.

Don't pre-split before that trigger. Three similar lines is better than
a premature abstraction — and the right split shape is easier to see
once the first orchestration tool exists than before.

## Transport modes

The same image supports two transports, selected at start time:

- **stdio (default)** — used when `MCP_PORT` is unset. Server reads
  MCP wire from stdin and writes to stdout. Standard mode for
  `docker run -i` invocation by an MCP client.
- **HTTP (Streamable HTTP)** — used when `MCP_PORT` is set to a port
  number. Server listens on `0.0.0.0:$MCP_PORT` with two endpoints:
  - `POST/GET/DELETE /mcp` — MCP Streamable HTTP per spec; per-session
    `mcp-session-id` header. Clients initialize via `POST /mcp` (no
    session header) which mints a UUID; subsequent requests reuse it.
  - `GET /health` — liveness probe (used by docker healthcheck).
    Includes the list of enabled clients for visibility.

  Per-session `McpServer` instances via the `createServer()` factory;
  client configs are read once at startup from env vars.

The two modes are mutually exclusive in a given process.

## Common Commands

```bash
npm install            # install deps
npm run build          # tsc → dist/
npm run dev            # tsx src/index.ts (needs at least one client's env vars)
npm test               # vitest run (no credentials needed)
npm run typecheck      # tsc -p tsconfig.typecheck.json (includes tests)
docker build -t downloader-mcp .
```

## Conventions

- All logging goes to **stderr** (`console.error`). stdout is the MCP
  wire protocol — writing to it corrupts the transport.
- Tool names: `<client>_<verb_noun>` (e.g. `sabnzbd_queue`,
  `qbittorrent_list_torrents`). Always snake_case, always client-prefixed.
- Tool inputs validated with `zod`. Outputs returned as a single
  JSON-stringified text content block via `asText()`.
- Clients are **optional**. Missing env vars → tools simply aren't
  registered. Server exits 1 only if zero clients are configured.
- Credentials (API keys, passwords) only via env vars. Never logged,
  never written to disk inside the container.

## qBittorrent specifics

- Auth is a static `Authorization: Bearer <QBITTORRENT_API_KEY>` header
  on every request — no login step, no session, no cookie, nothing to
  refresh on 403 (a 403 just means the key is wrong/revoked).
- Requires qBittorrent >= v5.2.0 (WebAPI >= v2.14.1), which introduced
  API key auth. Generate the key under WebUI Options > API Key. Only
  one key exists at a time; regenerating it immediately invalidates
  the previous one.

## Testing

`vitest`, colocated next to the code under test (standard MCP-D02) and
discovered via `vitest.config.ts`'s `src/**/*.test.ts`. `npm test` needs no
credentials and no live upstream.

- `src/mcp-route.test.ts` — Streamable HTTP session lifecycle. Boots a real
  Express listener and asserts the status contract over the wire: an unknown
  or swept session answers **404** (never 400, which leaves a client wedged
  after a routine eviction), a non-initialize request with no session
  answers 400, bearer auth is checked *before* session handling, and the
  Host allowlist matches the full `host:port`.

`npm run typecheck` uses `tsconfig.typecheck.json`, which unlike the build
config includes `*.test.ts` — vitest transpiles without typechecking, so
without it test code is the one part of the repo nothing type-checks.

Integration tests against real SABnzbd and qBittorrent instances should be
env-gated when added (don't mock — see the working-style note about
mocked-vs-real divergence).

## MCP tooling (local workstation)

This repo is registered with two MCP servers for Claude Code sessions
opened in this directory:

- **Serena** — user-scoped (available in every project on this machine).
  Project memories are written under the `downloader-mcp` Serena project.
  Re-onboarding isn't needed; if memories drift, update them with
  `mcp__serena__write_memory`.
- **OpenChronicle** — registered at *local scope* for this directory
  via `claude mcp add openchronicle -- oc mcp serve`. Effective for
  future Claude Code sessions opened with cwd = repo root. Config lives
  in `~/.claude.json` under the project entry — not committed.

If you re-clone the repo on another machine, re-register OpenChronicle
with the same command. Serena will work automatically if it's already
user-scoped on that machine.
