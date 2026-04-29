# downloader-mcp

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
| qBittorrent | `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD` | 8080 |

API keys / credentials are found in each app's settings:
- SABnzbd: *Config → General → API Key*
- qBittorrent: *Tools → Options → Web UI* (default user `admin`)

> **Note:** SABnzbd and qBittorrent both default to port 8080. If you
> run both on the same host, remap one of them in its own config.

At least one client must be configured or the server exits with an error.

## Run with Docker

```bash
docker build -t downloader-mcp .
docker run -i --rm \
  -e SABNZBD_URL=http://192.168.1.50:8080 -e SABNZBD_API_KEY=... \
  -e QBITTORRENT_URL=http://192.168.1.50:8081 \
  -e QBITTORRENT_USERNAME=admin -e QBITTORRENT_PASSWORD=... \
  downloader-mcp
```

## Published image

After each push to `main`, GitHub Actions builds and pushes a multi-arch
image to GHCR:

`ghcr.io/carldog/downloader-mcp:latest` (linux/amd64 + linux/arm64)

Pull instead of building locally:

```bash
docker pull ghcr.io/carldog/downloader-mcp:latest
docker run -i --rm \
  -e SABNZBD_URL=... -e SABNZBD_API_KEY=... \
  ghcr.io/carldog/downloader-mcp:latest
```

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
        "-e", "QBITTORRENT_USERNAME", "-e", "QBITTORRENT_PASSWORD",
        "downloader-mcp"
      ],
      "env": {
        "SABNZBD_URL": "http://192.168.1.50:8080",
        "SABNZBD_API_KEY": "...",
        "QBITTORRENT_URL": "http://192.168.1.50:8081",
        "QBITTORRENT_USERNAME": "admin",
        "QBITTORRENT_PASSWORD": "..."
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
