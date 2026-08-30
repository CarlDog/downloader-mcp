import { describe, expect, it } from "vitest";
import {
  COMPACT_TORRENT_FIELDS,
  buildAddTorrentForm,
  buildTorrentListQuery,
  compactTorrent,
  formatTorrentPage,
  parseMagnetUri,
  summarizeAddAcknowledgement,
} from "./qbittorrent.js";

function torrent(hash: string): Record<string, unknown> {
  return {
    hash,
    name: `Torrent ${hash}`,
    state: "downloading",
    progress: 0.5,
    dlspeed: 1024,
    magnet_uri: `magnet:?xt=urn:btih:${hash}`,
    tracker: "https://tracker.example/announce",
  };
}

describe("buildTorrentListQuery", () => {
  it("uses an extra upstream row to determine whether another page exists", () => {
    expect(buildTorrentListQuery({ limit: 25, offset: 50 })).toEqual({
      limit: "26",
      offset: "50",
    });
  });

  it("forwards status and de-duplicated hashes using qBittorrent syntax", () => {
    expect(
      buildTorrentListQuery({
        filter: "downloading",
        hashes: ["aaa", " bbb ", "aaa"],
      }),
    ).toEqual({
      limit: "26",
      offset: "0",
      filter: "downloading",
      hashes: "aaa|bbb",
    });
  });

  it("rejects unbounded pages, negative offsets, and embedded delimiters", () => {
    expect(() => buildTorrentListQuery({ limit: 101 })).toThrow(/1 to 100/);
    expect(() => buildTorrentListQuery({ offset: -1 })).toThrow(/non-negative/);
    expect(() => buildTorrentListQuery({ hashes: ["aaa|bbb"] })).toThrow(
      /may not contain/,
    );
  });
});

describe("compactTorrent", () => {
  it("returns a stable field set without bulky magnet or tracker values", () => {
    const result = compactTorrent(torrent("aaa"));

    expect(Object.keys(result)).toEqual(COMPACT_TORRENT_FIELDS);
    expect(result.hash).toBe("aaa");
    expect(result.trackers_count).toBeNull();
    expect(result).not.toHaveProperty("magnet_uri");
    expect(result).not.toHaveProperty("tracker");
  });
});

describe("formatTorrentPage", () => {
  it("defensively truncates an over-returning upstream and reports a next page", () => {
    const result = formatTorrentPage(
      [torrent("aaa"), torrent("bbb"), torrent("ccc")],
      { limit: 2, offset: 10 },
    );

    expect(result).toMatchObject({
      returned: 2,
      offset: 10,
      limit: 2,
      has_more: true,
      next_offset: 12,
      mode: "compact",
    });
    expect(result.torrents.map((item) => item.hash)).toEqual(["aaa", "bbb"]);
    expect(result.torrents[0]).not.toHaveProperty("magnet_uri");
  });

  it("preserves upstream fields only through the explicit full escape hatch", () => {
    const result = formatTorrentPage([torrent("aaa")], {
      limit: 1,
      full: true,
    });

    expect(result.mode).toBe("full");
    expect(result.has_more).toBe(false);
    expect(result.next_offset).toBeNull();
    expect(result.torrents[0]).toHaveProperty("magnet_uri");
  });

  it("fails closed on malformed upstream list and item shapes", () => {
    expect(() => formatTorrentPage({ torrents: [] })).toThrow(
      /malformed torrent list/,
    );
    expect(() => formatTorrentPage(["not-an-object"])).toThrow(
      /malformed torrent record/,
    );
  });
});

describe("parseMagnetUri", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";

  it("accepts a scoped magnet and extracts a verifiable hexadecimal hash", () => {
    expect(parseMagnetUri(`magnet:?xt=urn:btih:${hash}&dn=Example`)).toEqual({
      uri: `magnet:?xt=urn:btih:${hash}&dn=Example`,
      expectedInfoHash: hash,
    });
  });

  it("rejects remote URLs, delimiter injection, and magnets without a hash", () => {
    expect(() => parseMagnetUri("https://example.test/file.torrent")).toThrow(
      /Only magnet URIs/,
    );
    expect(() =>
      parseMagnetUri(`magnet:?xt=urn:btih:${hash}\nhttps://example.test`),
    ).toThrow(/line breaks/);
    expect(() => parseMagnetUri("magnet:?dn=NoHash")).toThrow(/exact topic/);
  });
});

describe("buildAddTorrentForm", () => {
  const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

  it("adds stopped by default and supports an explicit existing category", () => {
    const form = buildAddTorrentForm(magnet, { category: "linux" });
    expect(form.get("urls")).toBe(magnet);
    expect(form.get("paused")).toBe("true");
    expect(form.get("category")).toBe("linux");
  });

  it("starts only through an explicit override", () => {
    const form = buildAddTorrentForm(magnet, { startImmediately: true });
    expect(form.get("paused")).toBe("false");
  });
});

describe("summarizeAddAcknowledgement", () => {
  it("distinguishes legacy text rejection from acknowledgement", () => {
    expect(summarizeAddAcknowledgement("Ok.").status).toBe("acknowledged");
    expect(summarizeAddAcknowledgement("Fails.").status).toBe("rejected");
  });

  it("reduces newer JSON responses to non-sensitive counts", () => {
    expect(
      summarizeAddAcknowledgement({
        success_count: 1,
        pending_count: 0,
        failure_count: 0,
        added_torrent_ids: ["secret-source-data-is-not-returned"],
      }),
    ).toEqual({
      status: "acknowledged",
      counts: { success: 1, pending: 0, failure: 0 },
    });
  });
});
