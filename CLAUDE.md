# downloader-mcp

MCP server for download clients (SABnzbd, qBittorrent), packaged as a
Docker container. Designed as a companion to media-management MCPs
like `servarr-mcp`.

## Status

Single source of truth: [STATUS.md](STATUS.md). Do not duplicate status
into this file, MEMORY.md, or Serena memories — reference STATUS.md.

## Current Sprint

**Phase: scaffolding** — see [STATUS.md](STATUS.md) for the active
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
- **qBittorrent**: REST-ish (`/api/v2/...`) with form-login session
  cookie auth (`POST /api/v2/auth/login` → `SID` cookie).

Each client is fully self-contained in its own file. Adding a third
client (Deluge, Transmission, NZBGet, etc.) means a new file and a new
optional registration in `src/index.ts` — no inheritance refactor.

## Layout

- `src/index.ts` — MCP server entry. Reads env vars and conditionally
  registers each client whose full config is present.
- `src/util.ts` — single `asText()` helper used by both clients.
- `src/sabnzbd.ts` — `SabnzbdClient` + `registerSabnzbdTools`.
- `src/qbittorrent.ts` — `QBittorrentClient` (with session-cookie
  handling and 403 retry) + `registerQbittorrentTools`.
- `Dockerfile` — multi-stage build (alpine, non-root user).
- `.githooks/pre-commit` — gitleaks + PII pattern scan.

## Common Commands

```bash
npm install            # install deps
npm run build          # tsc → dist/
npm run dev            # tsx src/index.ts (needs at least one client's env vars)
npm run typecheck      # tsc --noEmit
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

- Login is lazy: triggered on the first request via `ensureLoggedIn()`.
- Session cookie cached in-memory on the client instance.
- On 403, the client retries once with a fresh login (handles
  session expiry mid-session). The retry guard prevents infinite loops.
- Multiple concurrent first-requests share a single login Promise to
  avoid double-login races.

## Testing

No tests yet. When added, integration tests against real SABnzbd and
qBittorrent instances behind env-gated tests (don't mock — see
working-style note about mocked-vs-real divergence).
