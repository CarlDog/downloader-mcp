# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The v0.1.0 entry is a backfill (standards UNI-12 / UNI-19) reconstructed from
git history and STATUS.md — this repo shipped to the NAS before it carried a
changelog. From here forward, update this file alongside the work rather than
after the fact.

## [Unreleased]

### Changed

- **Package renamed to `@carldog/downloader-mcp`.** The unscoped name
  `downloader-mcp` was still free, but three fleet repos had already lost
  theirs to unrelated packages; a scope is reserved to the account, so no
  name inside it can be taken. Nothing is published to npm - this ships as a
  container - so the rename is invisible to consumers; `package-lock.json`
  was regenerated with it.
- **`package.json` is now `private: true`.** It makes the config honest
  (there is no publish workflow and no `NPM_TOKEN`) and makes an accidental
  `npm publish` fail instead of succeeding.

## [0.1.0] - 2026-08-28

First tagged release. Deployed on the NAS; read-only by design in v1.

### Added

- SABnzbd tools — `sabnzbd_queue`, `sabnzbd_history`, `sabnzbd_categories`,
  `sabnzbd_version`.
- qBittorrent tools — `qbittorrent_list_torrents`, `qbittorrent_get_torrent`,
  `qbittorrent_torrent_files`, `qbittorrent_categories`,
  `qbittorrent_transfer_info`, `qbittorrent_version`.
- Each client is optional: tools are registered only for the client whose URL
  and key are both configured, so the visible tool set reflects what actually
  runs.
- Dual transport — stdio by default, Streamable HTTP when `MCP_PORT` is set.
- The reported server version is derived from `package.json`
  (`src/version.ts` + `src/version-sync.test.ts`, fleet standard MCP-T03).

### Changed

- qBittorrent auth moved from session-cookie login to a static API key
  (requires qBittorrent >= 5.2.0 / WebAPI >= 2.14.1) — no session, no login
  step, no cookie to expire.
- Moved onto the shared Docker `bridge` network, relieving the NAS's
  exhausted default address pool.
- `flavor: latest=false` on the publish workflow, so a release tag publishes
  `X.Y.Z` and `X.Y` without republishing `:latest` (UNI-19).

### Fixed

- Transport failures surface their real cause instead of Node's bare
  `TypeError: fetch failed` (MCP-F08). A dead `QBITTORRENT_URL` had stayed
  silently broken because every failure reported the same generic message;
  this repo's incident is what prompted the fleet-wide sweep.
- Idle HTTP sessions are evicted, bounding the per-session transport map.
- A session the server no longer knows answers HTTP 404, not 400.
- Secret params are redacted in logs and responses.
