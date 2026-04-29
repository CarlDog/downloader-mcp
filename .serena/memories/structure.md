# Codebase structure

```
downloader-mcp/
├── src/
│   ├── index.ts        # MCP server entry — env-driven conditional registration
│   ├── util.ts         # asText() helper (shared MCP-output formatter)
│   ├── sabnzbd.ts      # SabnzbdClient + registerSabnzbdTools
│   └── qbittorrent.ts  # QBittorrentClient (lazy login, 403 retry) + registerQbittorrentTools
├── dist/               # tsc output — gitignored
├── .githooks/
│   └── pre-commit      # gitleaks + PII pattern scan
├── Dockerfile          # multi-stage: build → runtime (alpine, non-root user `mcp`)
├── package.json        # type: module, ESM
├── tsconfig.json       # strict + noUncheckedIndexedAccess
├── .gitignore
├── .gitleaks.toml
├── .dockerignore
├── .env.example        # both clients' env vars (placeholders)
├── CLAUDE.md
├── STATUS.md           # single source of truth for project status
└── README.md
```

**Tools registered** (all read-only, 10 total):

| Client | Tools |
| --- | --- |
| SABnzbd (4) | queue, history, categories, version |
| qBittorrent (6) | list_torrents, get_torrent, torrent_files, transfer_info, categories, version |

**Adding a tool** to an existing client:
1. Add a method to the client class in `src/<client>.ts`
2. Add a `server.registerTool(...)` call inside that file's
   `register<Client>Tools` function
3. Use `zod` for input schema; wrap the result with `asText()` from `./util.js`

**Adding a new download client:**
1. Create `src/<client>.ts` with its own self-contained client class
   (no base inheritance) and a `register<Client>Tools` function
2. Add an env-var-conditional registration block to `src/index.ts`
3. Update `.env.example`, README.md tools table, CLAUDE.md, and STATUS.md
