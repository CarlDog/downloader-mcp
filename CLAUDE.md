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
