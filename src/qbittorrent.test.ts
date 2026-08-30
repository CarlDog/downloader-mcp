import { describe, expect, it } from "vitest";
import {
  COMPACT_TORRENT_FIELDS,
  DIAGNOSTIC_PREFERENCE_FIELDS,
  compactTorrentPeer,
  buildAddTorrentForm,
  buildTorrentListQuery,
  compactTorrent,
  formatTorrentPage,
  formatTorrentPeerPage,
  parseMagnetUri,
  projectDiagnosticPreferences,
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

describe("projectDiagnosticPreferences", () => {
  it("returns a stable diagnostic allowlist with a normalized encryption mode", () => {
    const result = projectDiagnosticPreferences({
      dht: true,
      pex: true,
      encryption: 1,
      current_network_interface: "tun0",
      proxy_bittorrent: true,
    });

    expect(Object.keys(result)).toEqual([
      ...DIAGNOSTIC_PREFERENCE_FIELDS,
      "encryption_mode",
    ]);
    expect(result.dht).toBe(true);
    expect(result.encryption_mode).toBe("require");
    expect(result.lsd).toBeNull();
  });

  it("never projects credentials, addresses, paths, or WebUI material", () => {
    const result = projectDiagnosticPreferences({
      proxy_ip: "proxy.internal",
      proxy_port: 8080,
      proxy_username: "operator",
      proxy_password: "credential",
      save_path: "/downloads",
      current_interface_address: "10.0.0.2",
      web_ui_api_key: "credential",
      mail_notification_password: "credential",
    });

    for (const field of [
      "proxy_ip",
      "proxy_port",
      "proxy_username",
      "proxy_password",
      "save_path",
      "current_interface_address",
      "web_ui_api_key",
      "mail_notification_password",
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("fails closed when qBittorrent does not return an object", () => {
    expect(() => projectDiagnosticPreferences([])).toThrow(
      /malformed application preferences/,
    );
  });
});

describe("compactTorrentPeer", () => {
  const peer = {
    ip: "203.0.113.10",
    port: 51413,
    host_name: "peer.example",
    peer_id_client: "-CLIENT-",
    i2p_dest: "sensitive.b32.i2p",
    files: "/downloads/private/file",
    client: "ExampleClient 1.0",
    progress: 0.75,
    dl_speed: 1024,
    up_speed: 512,
    downloaded: 2048,
    uploaded: 1024,
    connection: "uTP",
    flags: "I E H X",
    flags_desc: "localized verbose descriptions",
    country: "Example",
    country_code: "ex",
  };

  it("normalizes connection evidence while omitting peer identity by default", () => {
    const result = compactTorrentPeer(peer);
    expect(result).toMatchObject({
      client: "ExampleClient 1.0",
      connection: "uTP",
      flags: "I E H X",
      incoming: true,
      encryption: "traffic",
      sources: ["dht", "pex"],
    });
    for (const field of [
      "address",
      "ip",
      "port",
      "host_name",
      "peer_id_client",
      "i2p_dest",
      "files",
      "flags_desc",
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("includes only IP and port through the explicit address opt-in", () => {
    const result = compactTorrentPeer(peer, true);
    expect(result.address).toEqual({ ip: "203.0.113.10", port: 51413 });
    expect(result).not.toHaveProperty("host_name");
    expect(result).not.toHaveProperty("peer_id_client");
    expect(result).not.toHaveProperty("i2p_dest");
    expect(result).not.toHaveProperty("files");
  });
});

describe("formatTorrentPeerPage", () => {
  const response = {
    rid: 7,
    full_update: true,
    peers: {
      "203.0.113.3:3": { client: "three", flags: "e L" },
      "203.0.113.1:1": { client: "one", flags: "" },
      "203.0.113.2:2": { client: "two", flags: "I" },
    },
  };

  it("pages a deterministic order and reports exact traversal metadata", () => {
    expect(formatTorrentPeerPage(response, { limit: 2, offset: 1 })).toEqual({
      peers: [
        expect.objectContaining({ client: "two", incoming: true }),
        expect.objectContaining({
          client: "three",
          encryption: "handshake",
          sources: ["lsd"],
        }),
      ],
      returned: 2,
      total: 3,
      offset: 1,
      limit: 2,
      has_more: false,
      next_offset: null,
      addresses_included: false,
      response_id: 7,
      full_update: true,
    });
  });

  it("rejects malformed payloads and unbounded pages", () => {
    expect(() => formatTorrentPeerPage({ peers: [] })).toThrow(
      /malformed peer map/,
    );
    expect(() => formatTorrentPeerPage(response, { limit: 101 })).toThrow(
      /1 to 100/,
    );
    expect(() =>
      formatTorrentPeerPage({ peers: { bad: "not-an-object" } }),
    ).toThrow(/malformed peer record/);
  });
});
