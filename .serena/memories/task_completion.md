# Task completion checklist

Before marking a code-touching task done:

1. **Typecheck:** `npm run typecheck` (must be clean)
2. **Build:** `npm run build` (must succeed; verifies `dist/*.js` outputs)
3. **Tests:** none yet — when added, run them here
4. **Lint:** none configured yet — skip
5. **Manual verification (when relevant):**
   - For SABnzbd tool changes: run `npm run dev` against a real SABnzbd
     instance, exercise via an MCP client, verify the JSON response.
   - For qBittorrent tool changes: same, plus confirm the session-cookie
     flow works (the first request triggers login). If you change auth
     handling, deliberately invalidate the session mid-run (e.g.
     restart qBittorrent) and confirm the 403-retry path recovers.
   - For Dockerfile changes: `docker build -t downloader-mcp .` and
     confirm `docker run -i --rm -e ... downloader-mcp` produces a
     clean stdio handshake with the expected tools registered.
6. **Endpoint verification (first time touching a new endpoint):**
   The API paths in this repo were derived from training data. The
   first time a new endpoint is exercised, verify against the live
   instance — query parameter names and response shapes sometimes
   differ from documentation. Update STATUS.md "Known Gaps" if a
   discrepancy is found and fixed.
7. **STATUS.md:** update in the same commit as the work if the change
   advances or alters project state. Don't batch status updates.
8. **Commit:** the pre-commit hook runs gitleaks AND the PII pattern
   scan automatically. If either fails, fix the underlying issue —
   never bypass with `--no-verify`.

## Don't

- Don't run `npm install` to "fix" build issues without understanding
  what changed.
- Don't introduce mocks for SABnzbd or qBittorrent in tests. Use real
  instances behind env-gated tests (per global working-style on
  mock/prod divergence).
- Don't lower the test bar to make code pass. Fix the code, not the test.
- Don't commit with the global git identity — verify
  `git config user.email` shows the noreply address before committing.
- Don't add a new client without also creating its env-var-conditional
  block in `src/index.ts`, updating `.env.example`, README.md tools
  table, and CLAUDE.md / STATUS.md.
- Don't promote shared code to a base class for the sake of symmetry.
  These clients are deliberately self-contained because their APIs are
  too different to abstract cleanly. Wait for a third client that
  actually shares semantics with one of the existing two before
  refactoring.
