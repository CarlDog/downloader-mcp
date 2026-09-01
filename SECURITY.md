# Security Policy

## Supported Versions

Only the latest release receives security fixes — tracked by the `latest` tag
on [`ghcr.io/carldog/downloader-mcp`](https://github.com/CarlDog/downloader-mcp/pkgs/container/downloader-mcp).
There is no LTS branch.

## Reporting a Vulnerability

Please report security issues privately using GitHub's
[Security Advisories](https://github.com/CarlDog/downloader-mcp/security/advisories/new)
for this repository, rather than opening a public issue.

Expect an initial response within a few days. This is a solo-maintained
project — there's no formal SLA and no bounty, but reports are taken
seriously and fixes for confirmed issues are prioritized over other work.

## What has real impact here

This server holds credentials for the download clients it talks to —
`SABNZBD_API_KEY` and `QBITTORRENT_API_KEY`, each with the URL of the
instance. Both clients can pause, delete and re-prioritise downloads through
their own APIs, so a leaked key is meaningful even though this server does not
expose those operations.

**Every tool here is a read.** That is a deliberate v1 boundary, not an
oversight, and it is part of the security posture: a compromised client cannot
delete a torrent or purge a queue through this server. Two consequences worth
reporting:

- **A tool that turns out to write.** If any tool mutates state on SABnzbd or
  qBittorrent, that breaks the stated read-only contract and callers' trust in
  the `readOnlyHint` annotations they filter on.
- **Credential exposure.** An API key reaching tool output, an error message,
  or a log line. qBittorrent in particular authenticates with a session
  cookie; a leak of that cookie is equivalent to a leak of the key.
- **Auth bypass on the HTTP transport.** `MCP_AUTH_TOKEN` gates `/mcp` and
  `MCP_ALLOWED_HOSTS` is the Host/Origin allowlist that blocks DNS rebinding
  from a browser on the host network. Binding loopback is *not* a substitute
  in a container — the container's loopback is its own, so the server binds
  `0.0.0.0` to be reachable at all.
- **Server-side request forgery** via a URL that reaches an unintended host.

## Deployment notes that are not vulnerabilities

Running with `MCP_AUTH_TOKEN` unset on a trusted network is an operator
choice; the server warns on startup. Configuring only one of the two clients
is supported — the unconfigured one simply registers no tools.
