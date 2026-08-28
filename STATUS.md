# Status

**Last updated:** 2026-08-18

## Phase

**2026-08-18 — moved to the shared `bridge` network to relieve an
exhausted Docker address pool.** The dedicated `downloader-mcp_default`
network (created automatically because `docker-compose.yml` didn't set
`network_mode`) was one of ~30 per-stack networks on the NAS, each
claiming its own subnet from Docker's default address pool; the fleet
exhausted both built-in fallback pools. `docker-compose.yml` now sets
`network_mode: bridge`, same as the rest of the single-container fleet
stacks (this repo has only one container and no need for container-name
DNS, so `bridge` is safe — see the fleet-wide `docker-deployments.md`
rule this migration follows). One-line change, redeployed clean.

**2026-08-18 — fetch failures now surface their real cause.** While
verifying the qBittorrent API-key deploy live (below) against the real
NAS instance, `qbittorrent_version` failed with Node/undici's generic
`fetch failed` — which discards the actual underlying reason
(DNS/connection/TLS) in `error.cause`. Confirmed the WebUI itself was
reachable from the LAN (`curl` got a real HTTP 403), so the opaque
error was blocking diagnosis of whatever *is* wrong. Added
`fetchWithCause()` in `util.ts` (both clients now route their raw
`fetch()` call through it) so the next failure will actually say why.
New `src/util.test.ts` (3 tests) exercises it against a real closed
port (genuine `ECONNREFUSED`, not mocked) and a real local server for
the happy path, plus a `redactSecrets` regression guard. Verified:
typecheck, build, test (15/15), lint, format:check all clean.

The improved error immediately paid off: deployed live, it revealed
`ECONNREFUSED 172.17.0.1:18080` — the NAS's `QBITTORRENT_URL` was
pointing at port 18080, which nothing listens on. The real qBittorrent
WebUI runs on **8081** (via the `gluetun` VPN sidecar in the
`qbittorrent-vpn` stack) — 18080 was stale, likely left over from
before qBittorrent moved behind that VPN container. This was an
operator-side config drift, not a code bug: README/`.env.example`
already documented `:8081` correctly. Fixed via
`portainer_set_stack_env` (merge-only, verified the other 3 vars
survived) and redeployed. Live-verified end-to-end:
`qbittorrent_version` → `v5.2.2`, `qbittorrent_list_torrents` →
real torrent list, `sabnzbd_version` → `5.0.4`. Both clients fully
working on the NAS as of this session.

**2026-08-18 — qBittorrent auth switched from WebUI session-cookie
login to a static Bearer API key.** qBittorrent v5.2.0 (WebAPI
v2.14.1) added native API key auth; `QBittorrentClient` now sends
`Authorization: Bearer <QBITTORRENT_API_KEY>` on every request instead
of `POST /api/v2/auth/login` + cached `SID` cookie. This deletes the
login/cookie/403-retry machinery entirely rather than adding a second
auth path — no reason to keep the weaker, more complex mechanism
alongside the new one. `QBITTORRENT_USERNAME`/`QBITTORRENT_PASSWORD`
are replaced by `QBITTORRENT_API_KEY` everywhere (env, compose,
README, CLAUDE.md) — this is a breaking config change for any existing
deployment. Verified: typecheck, build, test (12/12), lint,
format:check all clean.

Deployed to the NAS (Portainer git-stack auto-update picked up this
commit, `QBITTORRENT_API_KEY` set, container healthy) and now fully
verified live — see the entry above for the URL fix that was also
needed.

**2026-08-12 — terminated sessions now answer HTTP 404, not 400.** The
Streamable HTTP spec (2025-06-18, Session Management §3/§4) makes 404 the
client's only defined signal to re-initialize after the idle sweep evicts a
session; the old 400 turned a routine eviction into what the client reported
as a dead connection. Fleet-wide fix — this repo hand-rolls its `/mcp`
handler rather than using the canonical `http-transport.ts`, so the handler
was extracted out of the self-executing `src/index.ts` into
`src/mcp-route.ts` to give it a seam to test against. The idle threshold
is now env-driven (`MCP_SESSION_IDLE_MS`) instead of a bare constant, and
exposed in `docker-compose.yml` so Portainer can tune it.

**The vitest suite landed** (`src/mcp-route.test.ts`, 12 tests) — this
repo's first tests, so it also gained `vitest.config.ts`, a `test` script,
and `tsconfig.typecheck.json` (typecheck now covers `*.test.ts`, which the
build config excludes and vitest never checks). The suite was verified to
actually bite: reverting the 404 branch fails 3 of its tests. Verified
green: build, typecheck, test, lint, format:check, plus an end-to-end probe
against the built server (unknown session 404, GET without session 400,
initialize 200).

Deployed and verified — running on the NAS at
`http://your-nas:3003/mcp` with both SABnzbd and qBittorrent
configured. End-to-end smoke tests returned a real SABnzbd queue
(version 4.5.5, idle, 10.2 TB free) and a qBittorrent torrent list
(qBittorrent's session-cookie auth path verified).

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

## Done (fleet-review fixes, 2026-07-12)

- **Opt-in DNS-rebinding protection** for the HTTP transport via
  `MCP_ALLOWED_HOSTS` (comma-separated `host[:port]`). Fail-soft: unset
  keeps current behavior (LAN clients unaffected) with a startup warning.
  Documented in README + commented example in docker-compose.yml.
- **Idle-session eviction** for the HTTP transport: sessions with no
  activity for 30 min are swept every 5 min, so abandoned sessions no
  longer leak transports/McpServer instances.

## Done (dogfooding fixes, 2026-08-12)

Sourced from real-usage friction filed as OpenChronicle `mcp-feedback`
memories during actual downloader-mcp tool calls (radarr blocked-import
triage session + fleet-wide auth-hardening audit).

- **Fixed HIGH-severity credential leak:** `sabnzbd_history` (and every
  SABnzbd/qBittorrent response) echoed the NZBgeek indexer API key in
  plaintext — confirmed on a live record in both the `url` field and,
  independently, inside `stage_log[].actions[]` (a leak vector the
  original finding didn't name). Fixed with a generic pattern-based
  redaction chokepoint (`util.ts` `redactSecrets`) applied to every
  response in both clients, rather than a field-name allowlist — closes
  vectors not yet discovered too. The exposed NZBgeek key itself was
  rotated by the operator, independent of this code fix.
- **`sabnzbd_history` now compact-by-default** (`full: true` for the raw
  per-slot payload) — the original heavy payload (stage_log, md5sum,
  meta, etc.) timed out at `limit: 60`.
- **`sabnzbd_history` now passes through `search`, `category`, `nzo_ids`,
  `start`** — verified live against the real SABnzbd API that each param
  actually filters/pages rather than being silently ignored. `nzo_ids`
  is the same id Radarr/Sonarr expose as `downloadId`, enabling a direct
  cross-MCP lookup instead of eyeballing a name match.
- **`MCP_AUTH_TOKEN` bearer-token auth implemented** for the HTTP
  transport (didn't exist in code before — mirrors botify-mcp's
  timing-safe SHA-256 comparison). Both `MCP_AUTH_TOKEN` and
  `MCP_ALLOWED_HOSTS` are now real `${VAR:-default}` substitutions in
  `docker-compose.yml` (previously `MCP_ALLOWED_HOSTS` was commented out
  and unreachable from Portainer; `MCP_AUTH_TOKEN` had no wiring at all).
  Both opt-in, fail-soft, warned at startup when unset.
- Verified: typecheck, lint, format:check, build all clean; auth gate
  functionally verified end-to-end over real HTTP (no/wrong token → 401,
  correct token → passes gate, `/health` stays open).

## Done (fetch-cause diagnostics, 2026-08-18)

- Added `fetchWithCause()` (`util.ts`), a thin wrapper around the raw
  `fetch()` calls in both clients that rethrows a network-level failure
  with the underlying `error.cause` message appended, instead of
  Node/undici's bare `fetch failed`. Discovered live: verifying the
  qBittorrent API-key switch below hit exactly this opacity.
- `src/util.test.ts` (new, 3 tests): a genuine `ECONNREFUSED` against a
  closed local port (not mocked), a real local HTTP server for the
  happy path, and a `redactSecrets` regression guard.
- Verified: typecheck, build, test (15/15), lint, format:check all clean.

## Done (qBittorrent API-key auth, 2026-08-18)

- Replaced `QBittorrentClient`'s session-cookie login (`POST
  /api/v2/auth/login` → cached `SID` cookie, retry-once-on-403) with a
  static `Authorization: Bearer <QBITTORRENT_API_KEY>` header — no
  login step, no session state, nothing to refresh. Requires
  qBittorrent >= v5.2.0 / WebAPI >= v2.14.1.
- `QBITTORRENT_USERNAME` + `QBITTORRENT_PASSWORD` removed; replaced by
  `QBITTORRENT_API_KEY` in `.env.example`, `docker-compose.yml`,
  `README.md`, `CLAUDE.md`, and the server's MCP instructions string.
- Verified: typecheck, build, `npm test` (12/12), lint, format:check
  all clean.

- **Dev-chain eslint 10 + SDK 1.30 audit sweep (2026-07-29).** eslint
  ^10.8.0, @eslint/js ^10.0.1, eslint-config-prettier ^10.1.8;
  @modelcontextprotocol/sdk ^1.30.0 with @hono/node-server 2.0.12
  (GHSA-frvp-7c67-39w9). npm audit 0, was 5 high + 2 moderate.
  Lockfile written with pinned npm 10.9.8. Verified: lint, typecheck,
  build, format:check (no unit suite in the read-only v1). Runtime
  majors stay deferred per the closed npm-major PR.

## Next

- Wire into Claude Desktop and verify tool calls flow through end-to-end
  from the assistant (rather than via curl).
- Decide on writes (pause/resume/delete/add) — currently out of scope.
- Add *integration* tests once a real SAB/qBT test target is set up
  (don't mock). The test harness itself now exists (vitest, colocated,
  `src/**/*.test.ts`), so this is no longer a from-scratch setup — an
  env-gated suite alongside `src/mcp-route.test.ts` is all it needs.

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

- No *client* tests — a deliberate gap, not an oversight: there is no
  real SABnzbd/qBittorrent test target to run against, and per working
  style we don't mock these APIs. Revisit when a real test target
  exists. (Superseded in part 2026-08-12: the repo does now have a test
  suite and CI does now run `npm test` — but it covers the HTTP
  transport, which needs no upstream, not the two clients.)

- **`brace-expansion` high-severity advisory (GHSA-rgw5-rvv9-x895, DoS
  via unbounded intermediate arrays) reported by `npm audit`.** Dev-only
  — it enters through the eslint chain, not runtime deps, so it does not
  reach the shipped image. Present before vitest was added (plex-mcp
  reports the same advisory with no dependency change), so treat it as a
  fleet-wide dev-chain bump rather than a per-repo fix. Note this
  supersedes the "npm audit 0" claim in the 2026-07-29 dependency entry
  above — the advisory postdates it.
