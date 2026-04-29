# downloader-mcp — project overview

**Purpose:** MCP (Model Context Protocol) server that exposes download
clients — SABnzbd (usenet) and qBittorrent (torrents) — to MCP clients
(Claude Desktop, etc.). Designed as a companion to media-management
MCPs like servarr-mcp.

**Status:** See `STATUS.md` in the repo root — single source of truth.
Do not duplicate status here.

**Tech stack**
- TypeScript (Node 22+, ESM, `NodeNext` module resolution)
- `@modelcontextprotocol/sdk` v1.x — high-level `McpServer` API
- `zod` for tool input schemas
- Each client uses its own auth/HTTP shape (no shared base — see below)
- Multi-stage Docker build (alpine base, non-root user `mcp`)

**Transport:** stdio. MCP clients invoke `docker run -i --rm ...` and
pipe stdin/stdout to the container as the MCP wire.

**Auth shapes (per client):**
- SABnzbd: query-string GET API
  (`/api?mode=X&apikey=Y&output=json`). Single endpoint, mode-driven dispatch.
- qBittorrent: REST-ish (`/api/v2/...`) with form-login session cookie
  (`POST /api/v2/auth/login` → `SID` cookie). Cookie cached in-memory,
  retried once on 403 (handles session expiry).

**Repo:** https://github.com/CarlDog/downloader-mcp (public — upstream)

**Git author convention:** set the local repo author to a no-reply
email (e.g. GitHub's `<numeric-id>+<username>@users.noreply.github.com`
pattern) so personal email never lands in public commit metadata.
Configure per-repo, not globally — verify with `git config user.email`
before the first commit.

**Sister projects** (deliberately consistent conventions):
- plex-mcp (https://github.com/CarlDog/plex-mcp)
- servarr-mcp (https://github.com/CarlDog/servarr-mcp)

## Why no shared base class

Unlike servarr-mcp where Sonarr/Radarr/Lidarr/Readarr/Prowlarr share a
v1/v3 REST + `X-Api-Key` shape, SABnzbd and qBittorrent have nothing
in common at the protocol layer. SABnzbd is mode-dispatched query
strings; qBittorrent is REST + session cookies. A shared base would
force-fit the abstraction. Each client is fully self-contained in its
own file. Future clients (Deluge, Transmission, NZBGet) follow the
same pattern: new file, new optional registration, no inheritance.
