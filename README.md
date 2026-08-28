# downloader-mcp

<!-- fleet-confidence -->
![code confidence](https://img.shields.io/badge/code_confidence-good-yellow) <sub>· `claude-opus-4-8[1m]` · 2026-07-07 · [details](https://github.com/CarlDog/downloader-mcp/issues/1)</sub>
<!-- /fleet-confidence -->


An [MCP](https://modelcontextprotocol.io) server for download clients —
**SABnzbd** (usenet) and **qBittorrent** (torrents) — packaged as a
Docker container. Companion to media-management MCPs like
[`servarr-mcp`](https://github.com/CarlDog/servarr-mcp).

Each client is optional: configure only the ones you actually run, and
only those tools register.

## Tools

### SABnzbd (usenet)

| Tool | Description |
| --- | --- |
| `sabnzbd_queue` | Current download queue with speeds and ETAs |
| `sabnzbd_history` | Recent history (newest first) |
| `sabnzbd_categories` | Configured categories |
| `sabnzbd_version` | SABnzbd version info |

### qBittorrent (torrents)

| Tool | Description |
| --- | --- |
| `qbittorrent_list_torrents` | List torrents, optional status filter |
| `qbittorrent_get_torrent` | Torrent details by info-hash |
| `qbittorrent_torrent_files` | Files inside a torrent |
| `qbittorrent_transfer_info` | Global transfer stats |
| `qbittorrent_categories` | Configured categories |
| `qbittorrent_version` | qBittorrent application version |

## Configuration

Each client requires its full config block to enable; partial config
silently disables the client.

| Client | Required env vars | Default port |
| --- | --- | --- |
| SABnzbd | `SABNZBD_URL`, `SABNZBD_API_KEY` | 8080 |
| qBittorrent | `QBITTORRENT_URL`, `QBITTORRENT_API_KEY` | 8080 |

API keys are found in each app's settings:
- SABnzbd: *Config → General → API Key*
- qBittorrent: *Tools → Options → Web UI → API Key* (requires
  qBittorrent >= v5.2.0 / WebAPI >= v2.14.1)

> **Note:** SABnzbd and qBittorrent both default to port 8080. If you
> run both on the same host, remap one of them in its own config.

At least one client must be configured or the server exits with an error.

### HTTP transport hardening (optional)

When running in HTTP mode (`MCP_PORT` set), you can enable bearer-token
auth and DNS-rebinding protection with:

| Env var | Meaning |
| --- | --- |
| `MCP_AUTH_TOKEN` | Shared secret. When set, every `/mcp` request must carry `Authorization: Bearer <token>`; `/health` stays open for the docker healthcheck. |
| `MCP_ALLOWED_HOSTS` | Comma-separated `host[:port]` list. When set, requests whose `Host` header isn't in the list are rejected. |

Both are opt-in and fail-soft: unset keeps prior behavior (unauthenticated,
any Host accepted) so an existing deployment isn't broken by an upgrade,
and the server logs a one-line startup warning recommending each one.

Recommended `MCP_AUTH_TOKEN`: a random secret, e.g. `openssl rand -hex 32`,
passed by clients as `Authorization: Bearer <token>`.

Recommended `MCP_ALLOWED_HOSTS`: the host names/IPs clients actually use to
reach the server — e.g. the NAS IP and `host.docker.internal`
(`MCP_ALLOWED_HOSTS=192.168.1.50:3003,host.docker.internal:3003`).

## Run with Docker

```bash
docker build -t downloader-mcp .
docker run -i --rm \
  -e SABNZBD_URL=http://192.168.1.50:8080 -e SABNZBD_API_KEY=... \
  -e QBITTORRENT_URL=http://192.168.1.50:8081 \
  -e QBITTORRENT_API_KEY=... \
  downloader-mcp
```

## Published image

After each push to `main` (docs-only changes excluded), GitHub Actions
builds and pushes an image to GHCR:

`ghcr.io/carldog/downloader-mcp:latest` (linux/amd64 only — every
deployment target is x86-64; see `docker-publish.yml` for the ARM
tradeoff if that ever changes)

Pull instead of building locally:

```bash
docker pull ghcr.io/carldog/downloader-mcp:latest
docker run -i --rm \
  -e SABNZBD_URL=... -e SABNZBD_API_KEY=... \
  ghcr.io/carldog/downloader-mcp:latest
```

## Run with Docker Compose (HTTP, long-lived)

The compose file runs the server in HTTP mode (Streamable HTTP) for
long-lived deployment via Portainer or Compose. It pulls the published
image from `ghcr.io/carldog/downloader-mcp:latest`.

```bash
# Set whichever client credentials apply:
export SABNZBD_URL=http://192.168.1.50:8080; export SABNZBD_API_KEY=...
export QBITTORRENT_URL=http://192.168.1.50:8081
export QBITTORRENT_API_KEY=...
export HOST_PORT=3003  # optional, defaults to 3003

docker compose up
```

The MCP endpoint will be at `http://<host>:${HOST_PORT}/mcp`.

## Deploy via Portainer (Stack from Git)

1. In Portainer, *Stacks → Add Stack → Repository*.
2. Repository URL: `https://github.com/CarlDog/downloader-mcp`
3. Compose path: `docker-compose.yml`
4. Environment variables: set whichever client credentials apply, plus
   optionally `HOST_PORT`.
5. Deploy. Healthcheck reaches green within ~10 seconds.

## Use with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "downloader": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SABNZBD_URL", "-e", "SABNZBD_API_KEY",
        "-e", "QBITTORRENT_URL",
        "-e", "QBITTORRENT_API_KEY",
        "downloader-mcp"
      ],
      "env": {
        "SABNZBD_URL": "http://192.168.1.50:8080",
        "SABNZBD_API_KEY": "...",
        "QBITTORRENT_URL": "http://192.168.1.50:8081",
        "QBITTORRENT_API_KEY": "..."
      }
    }
  }
}
```

Drop the `-e`/`env` entries for whichever client you don't run.

## Local development

```bash
npm install
cp .env.example .env  # then edit
SABNZBD_URL=... SABNZBD_API_KEY=... npm run dev
```

## Security

- Container runs as a non-root user (`mcp`).
- Credentials passed via env vars — never baked into the image.
- A `.githooks/pre-commit` runs gitleaks (secrets) and a PII pattern
  check (user-home paths, personal-domain emails). Activate it once
  per clone: `git config core.hooksPath .githooks`.
