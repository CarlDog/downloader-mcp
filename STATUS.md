# Status

**Last updated:** 2026-04-28

## Phase

HTTP transport added (matching the plex-mcp pilot). Same image now
supports stdio and Streamable HTTP, selected by the `MCP_PORT` env var.
`docker-compose.yml` added for Portainer/Compose deployment. Pending
live smoke test of HTTP path against real SABnzbd and qBittorrent.

## Done

- Repo initialized with TypeScript + MCP SDK + two self-contained clients
- **SABnzbd** client (4 tools): queue, history, categories, version
- **qBittorrent** client (6 tools, session-cookie auth + 403 retry):
  list_torrents, get_torrent, torrent_files, transfer_info, categories,
  version
- Clients are optional via env vars (`SABNZBD_*`, `QBITTORRENT_*`).
  Missing → tools simply not registered. At least one client must be
  configured or the server exits with a clear error.
- Multi-stage Dockerfile (alpine, non-root user `mcp`)
- Security baseline: `.gitignore`, `.gitleaks.toml`, `.githooks/pre-commit`
  (gitleaks + PII pattern scan from the start)
- Project docs: CLAUDE.md, STATUS.md, README.md

## Done (post-scaffold)

- `npm install` + `tsc` clean. SDK and zod resolved cleanly; all 4
  dist outputs produced (index, util, sabnzbd, qbittorrent). 0 vulns.
- Public repo published at https://github.com/CarlDog/downloader-mcp
  with a no-PII commit author (CarlDog noreply).
- Serena project activated; five memories written (`project_overview`,
  `structure`, `suggested_commands`, `conventions`, `task_completion`).
  Memories are workstation-neutral from the start.
- OpenChronicle MCP server registered local-scope for this directory
  (`claude mcp add openchronicle -- oc mcp serve`).
- **Dual transport:** stdio (default) + Streamable HTTP (when `MCP_PORT`
  set). Per-session `McpServer` factory; `/mcp` endpoint with session-id
  header; `/health` for docker healthcheck (reports enabled clients).
  Express dependency added.
- **Compose deploy:** `docker-compose.yml` with HTTP transport on port
  `${HOST_PORT:-3003}:3000`, env passthrough for `SABNZBD_*` and
  `QBITTORRENT_*` vars, healthcheck via wget. Pulls
  `ghcr.io/carldog/downloader-mcp:latest`.

## Next

- Smoke-test the HTTP transport: deploy via Portainer (Stack from Git
  pointing at this repo) or `docker compose up` against real SABnzbd
  and qBittorrent instances. Hit `/mcp` with the MCP Inspector or curl,
  verify a tool roundtrip per client. qBittorrent's login flow is the
  highest-risk path — verify session cookie handling works.
- Smoke-test stdio path still works post-refactor: `docker run -i --rm
  -e SABNZBD_URL=... -e SABNZBD_API_KEY=... downloader-mcp`.
- Wire into Claude Desktop config (HTTP via `"url": "http://nas:3003/mcp"`
  or stdio via `docker run -i`) and verify tool calls flow through.
- After smoke test passes: decide on writes (pause/resume/delete/add).
  Currently out of scope.

## Open Decisions

None active. Decisions made during scaffolding:

- **Repo name:** `downloader-mcp`. Considered `etl-mcp` but rejected
  (ETL means data-pipeline ETL in industry parlance — would mislead
  anyone landing on the repo).
- **One repo, two clients:** combined despite no shared API surface.
  Reasoning: they fill the same role (download clients for the *arr
  stack) and combining keeps Claude Desktop config simple and adds
  room for future clients (Deluge, Transmission, NZBGet) as additional
  optional registrations.
- **No shared base class:** each client is self-contained. SABnzbd's
  query-string-with-apikey style and qBittorrent's session-cookie REST
  style have nothing in common. A base would force-fit the abstraction.
- **Read-only first:** smoke-test reads, then layer writes. Same
  pattern as plex-mcp and servarr-mcp.

## Known Gaps

- No tests yet
- No CI yet
- No published Docker image yet
- API paths and shapes match my training-data knowledge but haven't
  been verified against live instances. Most likely to shift:
  - SABnzbd `mode=get_cats` (categories endpoint name) — uncommon, may
    have changed in newer versions
  - qBittorrent's "Ok." login response (some forks may differ)
  - `/torrents/categories` response shape
- qBittorrent client retries once on 403. If a server has a custom
  rate-limit response that returns 403, this could mask it. Adjust if
  observed in practice.
