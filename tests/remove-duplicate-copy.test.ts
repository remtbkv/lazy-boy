// P1 of burn lazyboy-review 2026-10-03: "Remove from playlist" on a row badged "duplicate"
// deleted EVERY copy of the song from the real Spotify playlist, because Spotify's DELETE
// removes all occurrences of a uri and both copies wore the badge. Known answers:
// - render [A,B,A] → one badge (only the later copy);
// - remove row 3 of [A,B,A] → Spotify ends [A,B] (DELETE A, POST A at position 0), cache [A,B];
// - a playlist that changed on Spotify since the cache was read is never touched.
// The Spotify side is a scripted fetch that applies DELETE/POST to an in-memory playlist;
// the store is the throwaway SQLite file from tests/setup.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/spotify";

vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {}, redirect: () => {} }));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/lib/session", async () => {
  const { spotifyClient } = await import("@/lib/spotify");
  return { getSpotify: async () => spotifyClient("test-token", false, "sim") };
});

const uri = (id: string) => `spotify:track:${id}`;
const track = (id: string, title = id): Track => ({
  id,
  uri: uri(id),
  title,
  artist: "Artist",
  album: "Album",
  albumImage: null,
  durationMs: 1000,
});
const A = track("aaa");
const B = track("bbb");

type Call = { method: string; path: string; body: unknown };

// A one-playlist Spotify: GET returns the header (current snapshot; `localFiles` extra items
// count in its total but never come back as tracks) or one page of items, DELETE removes every
// occurrence of each uri, POST inserts at `position` (or appends). Each write moves the
// snapshot, as Spotify's does.
function scriptSpotify(items: string[], snapshot: string, localFiles = 0) {
  const pl = { items: [...items], snapshot, rev: 0 };
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (method === "GET" && url.pathname.endsWith("/items")) {
      return ok({
        items: pl.items.map((u) => {
          const id = u.split(":")[2];
          return {
            added_at: null,
            item: { id, uri: u, name: id, artists: [{ name: "Artist" }], album: { name: "Album", images: [] }, duration_ms: 1000 },
          };
        }),
        total: pl.items.length,
        next: null,
      });
    }
    if (method === "GET") {
      return ok({
        id: "p1",
        name: "2017+",
        description: "",
        owner: { id: "me", display_name: "me" },
        tracks: { total: pl.items.length + localFiles },
        images: [],
        public: false,
        collaborative: false,
        snapshot_id: pl.snapshot,
      });
    }
    if (method === "DELETE") {
      const gone = new Set((body.items as { uri: string }[]).map((i) => i.uri));
      pl.items = pl.items.filter((u) => !gone.has(u));
    } else if (method === "POST") {
      const at = body.position ?? pl.items.length;
      pl.items.splice(at, 0, ...(body.uris as string[]));
    }
    pl.snapshot = `s${++pl.rev}`;
    return ok({ snapshot_id: pl.snapshot });
  });
  return { pl, calls };
}

const db = await import("@/lib/db");
const actions = await import("@/app/(app)/actions");
const domain = await import("@/lib/spotify/domain");

describe("duplicate positions (pure)", () => {
  it("marks only the later copies, by position", () => {
    expect(domain.duplicatePositions([A, B, A])).toEqual([2]);
    expect(domain.duplicatePositions([A, A, B, A])).toEqual([1, 3]);
    expect(domain.duplicatePositions([A, B])).toEqual([]);
  });

  it("re-insert positions put the kept copies back where they were", () => {
    // [A,B,A] remove index 2 → after DELETE [B], A goes back at 0.
    expect(domain.reinsertPositions([A.uri, B.uri, A.uri], A.uri, 2)).toEqual([0]);
    // [A,B,A] remove index 0 → after DELETE [B], A goes back at 1.
    expect(domain.reinsertPositions([A.uri, B.uri, A.uri], A.uri, 0)).toEqual([1]);
    // [A,B,A,C,A] remove index 2 → [B,C]; A at 0, then A at 3 (after A,B,C).
    expect(domain.reinsertPositions([A.uri, B.uri, A.uri, "c", A.uri], A.uri, 2)).toEqual([0, 3]);
  });
});

describe("track list render", () => {
  it("[A,B,A] wears one duplicate badge", async () => {
    const { TrackList } = await import("@/components/track-list");
    const tracks = [A, B, A];
    const html = renderToStaticMarkup(
      createElement(TrackList, {
        tracks,
        duplicatePositions: domain.duplicatePositions(tracks),
        playlistId: "p1",
        canRemove: true,
      }),
    );
    expect(html.match(/>duplicate<\/span>/g)?.length).toBe(1);
  });
});

describe("removeFromPlaylistAction on a repeated track", () => {
  beforeEach(async () => {
    await db.storePlaylistTracks("p1", [A, B, A], "s0");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("removing row 3 of [A,B,A] leaves [A,B] on Spotify and in the cache", async () => {
    const { pl, calls } = scriptSpotify([A.uri, B.uri, A.uri], "s0");
    const r = await actions.removeFromPlaylistAction("p1", A.uri, 2);
    expect(r).toEqual({ ok: true });
    expect(pl.items).toEqual([A.uri, B.uri]);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      { method: "DELETE", path: "/v1/playlists/p1/items", body: { items: [{ uri: A.uri }] } },
      { method: "POST", path: "/v1/playlists/p1/items", body: { uris: [A.uri], position: 0 } },
    ]);
    expect((await db.getPlaylistTracks("p1")).map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });

  it("removing row 1 of [A,B,A] leaves [B,A]", async () => {
    const { pl } = scriptSpotify([A.uri, B.uri, A.uri], "s0");
    const r = await actions.removeFromPlaylistAction("p1", A.uri, 0);
    expect(r).toEqual({ ok: true });
    expect(pl.items).toEqual([B.uri, A.uri]);
    expect((await db.getPlaylistTracks("p1")).map((t) => t.id)).toEqual(["bbb", "aaa"]);
  });

  it("a playlist edited on Spotify since the cache was read is left alone, cache refreshed", async () => {
    const { pl, calls } = scriptSpotify([B.uri, A.uri, A.uri], "s9");
    const r = await actions.removeFromPlaylistAction("p1", A.uri, 2);
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(pl.items).toEqual([B.uri, A.uri, A.uri]);
    expect((await db.getPlaylistTracks("p1")).map((t) => t.id)).toEqual(["bbb", "aaa", "aaa"]);
  });

  it("a stale snapshot over an unchanged list (right after this app's own edit) still works", async () => {
    await db.storePlaylistTracks("p1", [A, B, A, A], "s0");
    const { pl } = scriptSpotify([A.uri, B.uri, A.uri, A.uri], "s0");
    expect(await actions.removeFromPlaylistAction("p1", A.uri, 3)).toEqual({ ok: true });
    expect(pl.items).toEqual([A.uri, B.uri, A.uri]);
    expect(pl.snapshot).not.toBe(await db.getPlaylistSnapshot("p1"));
    expect(await actions.removeFromPlaylistAction("p1", A.uri, 2)).toEqual({ ok: true });
    expect(pl.items).toEqual([A.uri, B.uri]);
    expect((await db.getPlaylistTracks("p1")).map((t) => t.id)).toEqual(["aaa", "bbb"]);
  });

  it("a playlist with local files (positions not Spotify's) is left alone", async () => {
    const { pl, calls } = scriptSpotify([A.uri, B.uri, A.uri], "s0", 1);
    const r = await actions.removeFromPlaylistAction("p1", A.uri, 2);
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(pl.items).toEqual([A.uri, B.uri, A.uri]);
  });

  it("a single-copy track is one DELETE with no snapshot read", async () => {
    const { pl, calls } = scriptSpotify([A.uri, B.uri, A.uri], "s0");
    const r = await actions.removeFromPlaylistAction("p1", B.uri, 1);
    expect(r).toEqual({ ok: true });
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(pl.items).toEqual([A.uri, A.uri]);
    expect((await db.getPlaylistTracks("p1")).map((t) => t.id)).toEqual(["aaa", "aaa"]);
  });
});
