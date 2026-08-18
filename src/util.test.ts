import { createServer, type Server } from "node:http";
import { describe, it, expect, afterAll } from "vitest";
import { fetchWithCause, redactSecrets } from "./util.js";

describe("fetchWithCause", () => {
  it("surfaces the underlying cause on a real connection failure", async () => {
    // An arbitrary high loopback port with nothing bound reliably produces
    // a real ECONNREFUSED without depending on outside network access, so
    // this exercises actual fetch() failure behavior rather than mocking
    // it. (Low ports like 1 hit fetch's own "bad port" block first, which
    // is a different failure mode than the network-level one under test.)
    await expect(fetchWithCause("http://127.0.0.1:45001/")).rejects.toThrow(
      /fetch failed.*ECONNREFUSED/s,
    );
  });

  describe("happy path", () => {
    let server: Server;
    let baseUrl: string;

    afterAll(() => {
      server?.close();
    });

    it("passes a successful response through unchanged", async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected server to bind a port");
      }
      baseUrl = `http://127.0.0.1:${address.port}/`;

      const res = await fetchWithCause(baseUrl);
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe("ok");
    });
  });
});

describe("redactSecrets", () => {
  it("still redacts secret query params (regression guard)", () => {
    const result = redactSecrets({
      url: "https://example.com/api?apikey=abc123&foo=bar",
    });
    expect(result.url).toBe(
      "https://example.com/api?apikey=[REDACTED]&foo=bar",
    );
  });
});
