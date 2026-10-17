// The library rescan (docs/multi-user/PLAN.md §7.7), sized for a friend with thousands of likes:
// no /me call (the Spotify id is on the users row; the scan's own me_id otherwise); every
// playlist's stored snapshot in one statement; Liked Songs read from the newest page until a
// stored (track, added_at) appears, diffed without `position`, so one like writes one row; paced
// background pages and a getAll that resumes from its cursor instead of failing at page 501; and
// the brake's counter awaited before any /me call that is still made (§7.5). A fake Spotify for
// the scan, the real client against a scripted fetch for the client's parts, the owner's store.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/spotify/types";
import type { UserStore } from "@/lib/db";
import { syncLibrary } from "@/lib/sync/library";
import { ownerStore, ownerUid } from "./owner-store";
import { resetStore } from "./adversarial/helpers";

type Spotify = Parameters<typeof syncLibrary>[0];

const track = (id: string, addedAt: string): Track => ({
  id,
  title: `song ${id}`,
  artist: "artist",
  uri: `spotify:track:${id}`,
  album: null,
  albumImage: null,
  durationMs: 200_000,
  addedAt,
});
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T12:00:00Z`;

/** A Spotify with one owned playlist and `liked` (newest first), paged `pageSize` at a time. */
function fakeSpotify(o: { liked: Track[]; pageSize?: number; owner?: string }) {
  const calls: string[] = [];
  const size = o.pageSize ?? 50;
  const sp = {
    me: async () => {
      calls.push("me");
      return { id: o.owner ?? "rem-spotify" };
    },
    myPlaylistsAll: async () => {
      calls.push("playlists");
      return [
        { id: "pl-1", name: "mine", ownerId: o.owner ?? "rem-spotify", image: null, trackCount: 1, snapshot: "s1" },
        { id: "pl-2", name: "theirs", ownerId: "someone", image: null, trackCount: 1, snapshot: "s2" },
      ];
    },
    playlistTracks: async (id: string) => {
      calls.push(`tracks:${id}`);
      return [track(`${id}-t`, day(1))];
    },
    savedTracksHead: async () => {
      calls.push("liked-head");
      return { total: o.liked.length, topAddedAt: o.liked[0]?.addedAt ?? null };
    },
    savedTracksPage: async (cursor: string | null) => {
      const from = cursor ? Number(cursor) : 0;
      calls.push(`liked-page:${from}`);
      const end = from + size;
      return { tracks: o.liked.slice(from, end), total: o.liked.length, next: end < o.liked.length ? String(end) : null };
    },
    savedTracks: async () => {
      calls.push("liked-all");
      return o.liked;
    },
  };
  return { sp: sp as unknown as Spotify, calls };
}

/** The store, counting which of its methods the scan calls (a copy: the store is frozen). */
function counted(store: UserStore) {
  const n = new Map<string, number>();
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store)) {
    copy[k] =
      typeof v !== "function"
        ? v
        : (...a: unknown[]) => {
            n.set(k, (n.get(k) ?? 0) + 1);
            return (v as (...x: unknown[]) => unknown)(...a);
          };
  }
  return { store: copy as unknown as UserStore, n };
}

beforeEach(resetStore);

describe("the rescan (PLAN §7.7)", () => {
  it("makes no /me call: the owned-playlist filter takes the Spotify id it is given, and stores it", async () => {
    const { sp, calls } = fakeSpotify({ liked: [] });
    await syncLibrary(sp, ownerStore(), undefined, { meId: "rem-spotify" });
    expect(calls).not.toContain("me");
    expect(calls).toContain("tracks:pl-1");
    expect(calls).not.toContain("tracks:pl-2");
    expect(await ownerStore().getMeId()).toBe("rem-spotify");
  });

  it("with no id given it uses the me_id an earlier scan stored; /me only when there is neither", async () => {
    const first = fakeSpotify({ liked: [] });
    await syncLibrary(first.sp, ownerStore());
    expect(first.calls).toContain("me");
    const again = fakeSpotify({ liked: [] });
    await syncLibrary(again.sp, ownerStore());
    expect(again.calls).not.toContain("me");
  });

  it("reads every playlist's stored snapshot in one statement", async () => {
    const { sp } = fakeSpotify({ liked: [] });
    const { store, n } = counted(ownerStore());
    await syncLibrary(sp, store, undefined, { meId: "rem-spotify" });
    expect(n.get("getPlaylistSnapshot") ?? 0).toBe(0);
    expect(n.get("getPlaylistSnapshots")).toBe(1);
  });
});

describe("Liked Songs for a friend with thousands (scale 3)", () => {
  const three = [track("c", day(3)), track("b", day(2)), track("a", day(1))];

  it("one like writes one row, though every position moved", async () => {
    expect(await ownerStore().storeSavedTracks(three)).toBe(3);
    expect(await ownerStore().storeSavedTracks([track("d", day(4)), ...three])).toBe(1);
  });

  it("a scan after one like reads one page and writes the one row; nothing changed reads one page and writes none", async () => {
    await ownerStore().storeSavedTracks(three);
    const liked = [track("d", day(4)), ...three];
    const { sp, calls } = fakeSpotify({ liked, pageSize: 2 });
    const { store, n } = counted(ownerStore());
    await syncLibrary(sp, store, undefined, { meId: "rem-spotify" });
    expect(calls.filter((c) => c.startsWith("liked-page"))).toEqual(["liked-page:0"]);
    expect(calls).not.toContain("liked-all");
    expect((await ownerStore().getLibraryTracks()).map((t) => t.id).sort()).toEqual(["a", "b", "c", "d", "pl-1-t"]);
    expect(n.get("recomputeUniqueSongCount")).toBe(1); // the library changed

    // The daily check a day later, nothing changed: one page, no write, no unique-song recount.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    try {
      const quiet = fakeSpotify({ liked, pageSize: 2 });
      const c2 = counted(ownerStore());
      await syncLibrary(quiet.sp, c2.store, undefined, { meId: "rem-spotify" });
      expect(quiet.calls.filter((c) => c.startsWith("liked-page"))).toEqual(["liked-page:0"]);
      expect(c2.n.get("recomputeUniqueSongCount") ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unlike the head cannot see refetches the whole list once", async () => {
    await ownerStore().storeSavedTracks(three);
    // "b" unliked: the newest page still starts with stored rows, and the count disagrees.
    const { sp, calls } = fakeSpotify({ liked: [three[0], three[2]], pageSize: 1 });
    await syncLibrary(sp, ownerStore(), undefined, { meId: "rem-spotify" });
    expect(calls).toContain("liked-all");
    expect((await ownerStore().getLibraryTracks()).map((t) => t.id).sort()).toEqual(["a", "c", "pl-1-t"]);
  });
});

describe("the rescan's deadline (PLAN §7.2 step 4: one rescan a tick, under its own deadline)", () => {
  // 300 likes stored; Spotify now lists 299 (one unliked mid-list), 50 a page, each page 40 ms
  // away: the head meets the store on its first row and the count disagrees, so a refetch.
  const likes = Array.from({ length: 300 }, (_, i) => track(`t${i}`, new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString()));
  const listed = likes.filter((_, i) => i !== 150);
  const raw = (t: Track) => ({
    added_at: t.addedAt,
    track: { id: t.id, name: t.title, uri: t.uri, type: "track", artists: [{ name: t.artist }], album: { name: "album", images: [] }, duration_ms: 200_000 },
  });
  function slowSpotify() {
    const pages: number[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v1/me/playlists") return Response.json({ items: [], next: null, total: 0 });
      if (url.pathname !== "/v1/me/tracks") throw new Error(`unexpected ${url.pathname}`);
      await new Promise((r) => setTimeout(r, 40));
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (limit === 50) pages.push(offset);
      const end = offset + limit;
      const next = end < listed.length ? `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${end}` : null;
      return Response.json({ items: listed.slice(offset, end).map(raw), total: listed.length, next });
    });
    return pages;
  }

  it("a Liked refetch that cannot finish by the deadline stops there: nothing written, the scan not stamped, no throw", async () => {
    await ownerStore().storeSavedTracks(likes);
    const pages = slowSpotify();
    const { spotifyClient } = await import("@/lib/spotify");
    const sp = spotifyClient(ownerUid(), { uid: ownerUid(), accessToken: "tok" }, true, "test");
    await syncLibrary(sp, ownerStore(), undefined, { meId: "rem-spotify", deadline: Date.now() + 150 });
    vi.unstubAllGlobals();
    // The head's page and at most a couple of the refetch's, not the list's seven.
    expect(pages.length).toBeLessThan(5);
    expect((await ownerStore().getLikedSignals()).total).toBe(300);
    expect(await ownerStore().getLibrarySyncedAt()).toBeNull();
  });

  it("a head read that cannot meet the store by the deadline (a first scan of 299 likes) stops between its pages, writing nothing", async () => {
    const pages = slowSpotify();
    const { spotifyClient } = await import("@/lib/spotify");
    const sp = spotifyClient(ownerUid(), { uid: ownerUid(), accessToken: "tok" }, true, "test");
    await syncLibrary(sp, ownerStore(), undefined, { meId: "rem-spotify", deadline: Date.now() + 150 });
    vi.unstubAllGlobals();
    expect(pages.length).toBeLessThan(5);
    expect(await ownerStore().readSavedRows()).toEqual([]);
    expect(await ownerStore().getLibrarySyncedAt()).toBeNull();
  });

  it("…and with the time it needs, the same refetch writes the unlike", async () => {
    await ownerStore().storeSavedTracks(likes);
    const pages = slowSpotify();
    const { spotifyClient } = await import("@/lib/spotify");
    const sp = spotifyClient(ownerUid(), { uid: ownerUid(), accessToken: "tok" }, true, "test");
    await syncLibrary(sp, ownerStore(), undefined, { meId: "rem-spotify", deadline: Date.now() + 60_000 });
    vi.unstubAllGlobals();
    expect(pages).toEqual([0, 0, 50, 100, 150, 200, 250]);
    expect((await ownerStore().getLikedSignals()).total).toBe(299);
    expect(await ownerStore().getLibrarySyncedAt()).not.toBeNull();
  });
});

describe("the client's pages (PLAN §6.6, §7.7)", () => {
  async function client(handler: (url: URL) => Response) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(url.pathname + url.search);
      return handler(url);
    });
    const { HttpClient } = await import("@/lib/spotify/client");
    return { http: new HttpClient("tok", true, "test", null), urls };
  }

  it("getAll reads past page 500 by its cursor, where it used to throw", async () => {
    const { http, urls } = await client((url) => {
      const n = Number(url.searchParams.get("offset") ?? 0);
      const next = n + 1 < 600 ? `https://api.spotify.com/v1/x?offset=${n + 1}` : null;
      return Response.json({ items: [n], next, total: 600 });
    });
    const items = await http.getAll<number>("/x?offset=0");
    expect(items.length).toBe(600);
    expect(urls.length).toBe(600);
    vi.unstubAllGlobals();
  });

  it("a background read waits between pages", async () => {
    const { http } = await client((url) => {
      const n = Number(url.searchParams.get("offset") ?? 0);
      return Response.json({ items: [n], next: n < 3 ? `https://api.spotify.com/v1/x?offset=${n + 1}` : null, total: 4 });
    });
    const t0 = Date.now();
    expect(await http.getAll<number>("/x?offset=0", undefined, { paceMs: 40 })).toEqual([0, 1, 2, 3]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    vi.unstubAllGlobals();
  });

  it("the brake's counter is awaited before a /me call (§7.5), whether or not the call succeeds", async () => {
    const app = await import("@/lib/app-db");
    const { createClient } = await import("@libsql/client");
    const { quotaDay } = await import("@/lib/brake");
    await app.getAppMeta("schema_version");
    const raw = createClient({ url: app.appDatabaseUrl(), intMode: "number" });
    const uid = ownerUid();
    await raw.execute({ sql: "DELETE FROM sync_state WHERE uid = ?", args: [uid] });
    await raw.execute({ sql: "INSERT INTO sync_state (uid, state, next_probe_at) VALUES (?, 'idle', 0)", args: [uid] });
    let countedBefore: number | null = null;
    vi.stubGlobal("fetch", async () => {
      const r = await raw.execute({ sql: "SELECT rp_calls, quota_day FROM sync_state WHERE uid = ?", args: [uid] });
      countedBefore = Number(r.rows[0].rp_calls);
      expect(r.rows[0].quota_day).toBe(quotaDay(Date.now()));
      return new Response("upstream", { status: 500 });
    });
    const { spotifyClient } = await import("@/lib/spotify");
    await spotifyClient(uid, { uid, accessToken: "tok" }, false, "test").resources.me().catch(() => {});
    expect(countedBefore).toBe(1);
    raw.close();
    vi.unstubAllGlobals();
  });

  it("each /me the client re-sends is counted before it is sent too: a 403 retried once is two calls, two counts", async () => {
    const app = await import("@/lib/app-db");
    const { createClient } = await import("@libsql/client");
    await app.getAppMeta("schema_version");
    const raw = createClient({ url: app.appDatabaseUrl(), intMode: "number" });
    const uid = ownerUid();
    await raw.execute({ sql: "DELETE FROM sync_state WHERE uid = ?", args: [uid] });
    await raw.execute({ sql: "INSERT INTO sync_state (uid, state, next_probe_at) VALUES (?, 'idle', 0)", args: [uid] });
    const countedBefore: number[] = [];
    vi.stubGlobal("fetch", async () => {
      const r = await raw.execute({ sql: "SELECT rp_calls FROM sync_state WHERE uid = ?", args: [uid] });
      countedBefore.push(Number(r.rows[0].rp_calls));
      return new Response("forbidden", { status: 403 });
    });
    const { spotifyClient } = await import("@/lib/spotify");
    await spotifyClient(uid, { uid, accessToken: "tok" }, false, "test").resources.me().catch(() => {});
    expect(countedBefore).toEqual([1, 2]);
    raw.close();
    vi.unstubAllGlobals();
  });
});
