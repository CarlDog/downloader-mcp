import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Colocated tests — standard MCP-D02. This repo had no test directory
    // when tests were introduced, so the canonical layout applies: a test
    // sits next to the code it covers.
    include: ["src/**/*.test.ts"],
    // Integration suites (when they arrive) opt in via an env guard inside
    // the file itself, so a plain `npm test` never needs credentials or a
    // live SABnzbd/qBittorrent.
    environment: "node",
  },
});
