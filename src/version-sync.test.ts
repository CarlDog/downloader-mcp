// REQUIRED ENFORCEMENT TEST — fleet standard MCP-T03.
//
// SERVER_VERSION (src/version.ts) must equal package.json's version. These
// were previously two hand-maintained literals with nothing tying them
// together — bump one without the other and the MCP initialize response
// silently reports a stale version to every client.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { SERVER_VERSION } from "./version.js";

describe("version sync", () => {
  test("SERVER_VERSION matches package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  test("SERVER_VERSION is valid semver", () => {
    // Catches a half-finished bump such as "0.2" or a leftover placeholder.
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
