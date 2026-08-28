// Single source of truth for the server's reported version. Keep this in
// lockstep with package.json's "version" field — src/version-sync.test.ts
// enforces it, so bumping one without the other fails the suite in the same
// commit instead of shipping a stale version in the MCP initialize response.
//
// Eight of nine servers in the fleet kept these two literals in step by hand,
// and portainer-mcp's had already silently drifted by five minor versions. A
// comment asking the next person to remember has no failure mode; this does
// (fleet standard MCP-T03).
export const SERVER_VERSION = "0.1.0";
