import { describe, expect, it } from "vitest";
import {
  COMPACT_TORRENT_FIELDS,
  buildTorrentListQuery,
  compactTorrent,
  formatTorrentPage,
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
