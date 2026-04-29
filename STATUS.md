# Status

**Last updated:** 2026-04-28

## Phase

Scaffolding — initial repo structure created, build verification pending.

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

## Next

- `npm install` and verify `npm run build` succeeds
- Smoke-test against real SABnzbd and qBittorrent instances; confirm
  at least one tool per client returns sensible JSON. qBittorrent's
  login flow is the highest-risk path — verify session cookie handling
  works against a real WebUI.
- Build the Docker image and verify `docker run -i` connects via stdio
- Commit + push to GitHub (under CarlDog, public, no-PII commit author)
- Configure Serena project + onboarding memories
- Register OpenChronicle MCP locally for this directory
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
