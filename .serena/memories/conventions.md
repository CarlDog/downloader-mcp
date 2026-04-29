# Conventions

## MCP-specific (CRITICAL)

- **stdout is the MCP wire protocol.** Never `console.log` —
  it corrupts the transport. All logging goes to **stderr** via
  `console.error`. This applies to dependencies too.
- Tool names: `<client>_<verb_noun>` (e.g. `sabnzbd_queue`,
  `qbittorrent_list_torrents`). Always snake_case, always client-prefixed.
- Tool inputs: validated with `zod` schemas. Use `.describe(...)` on
  every field — descriptions surface to the LLM caller.
- Tool outputs: a single text content block with JSON-stringified
  payload. Use the `asText()` helper from `./util.js`.

## Client registration

- Clients are **optional**. Missing required env vars → the client's
  tools simply aren't registered. No warnings, no errors.
- SABnzbd needs `SABNZBD_URL` + `SABNZBD_API_KEY` (both required).
- qBittorrent needs `QBITTORRENT_URL` + `QBITTORRENT_USERNAME` +
  `QBITTORRENT_PASSWORD` (all three required).
- If zero clients are configured, the server exits 1 with a clear message.

## TypeScript

- ESM only (`"type": "module"`). Imports use `.js` extension even when
  importing `.ts` files (NodeNext convention).
- `strict: true` + `noUncheckedIndexedAccess: true`.
- Each client is self-contained — no base class inheritance. SABnzbd
  and qBittorrent share nothing at the API layer; forcing them into a
  common abstraction adds friction without value.
- No `any`. Use `unknown` and let the LLM consume the JSON payload.

## qBittorrent specifics

- Login is **lazy** — triggered on the first request via
  `ensureLoggedIn()`. Multiple concurrent first-requests share a single
  login Promise to avoid a double-login race.
- Session cookie is cached on the client instance (in-memory only —
  never persisted to disk).
- On a 403 response, the client retries once with a fresh login. The
  retry guard (`retried` parameter) prevents infinite loops if the
  fresh session also gets 403.
- Some endpoints return JSON, some return plain text (e.g.
  `/app/version`). The `request()` method dispatches based on the
  `content-type` response header.

## Docker

- Multi-stage. Build stage installs full deps + tsc; runtime stage gets
  only `dist/`, pruned `node_modules`, and `package.json`.
- Runtime image runs as non-root user `mcp`. Don't add `USER root`.
- Credentials passed at `docker run` time via `-e <VAR>`. Never bake
  into the image, never `ENV ...=...` in the Dockerfile.

## Security

- Per global rules: never print API keys or passwords. Error messages
  from `request()` redact response bodies via `.slice(0, 200)`.
  Audit if you change error handling.
- `.gitignore` excludes `*.pem`, `*.key`, `*.pfx`, `*.p12`, `.env`.
- Pre-commit hook runs gitleaks AND a PII pattern scan. Don't bypass
  with `--no-verify`.

## Git

- Local repo author is overridden to noreply (see `project_overview`).
  Don't `git config --unset` it — re-exposes PII.
- `git add <specific-files>`, not `git add .` or `git add -A`.
- Commit messages: imperative mood, short first line, body explaining
  *why* over *what*. End with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
