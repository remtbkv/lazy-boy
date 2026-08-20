// ADVERSARIAL — src/lib/format.ts, src/lib/filter.ts, src/lib/spotify/domain.ts,
// src/lib/store-diff.ts. Expectations from each function's docstring.

import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatListenTime,
  timeAgo,
  dayLabel,
  shortDate,
} from "@/lib/format";
import { fuzzyFilter } from "@/lib/filter";
import {
  keyOf,
  dedupeByKey,
  mergeUnique,
  subtract,
  intersect,
  findDuplicates,
} from "@/lib/spotify/domain";
import type { Track } from "@/lib/spotify/types";
import {
  tracksNeedingWrite,
  diffPositions,
  diffPlaylistList,
  diffKeyed,
  needsFullOrphanPass,
  newPlays,
  playKey,
  type TrackFields,
  type PositionRow,
  type PlaylistListRow,
} from "@/lib/store-diff";

const track = (over: Partial<Track> = {}): Track => ({
  id: "t1",
  artist: "Artist",
  title: "Title",
  uri: "spotify:track:t1",
  ...over,
});

// ---------------------------------------------------------------- format.ts

describe("format.ts", () => {
  it("formatDuration renders the dash for <= 0, NaN and non-finite", () => {
    // "`<= 0` and NaN both render the dash — a negative used to render '-1:-1'"
    // (format.ts:14)
    for (const v of [0, -1, -100_000, Number.NaN, Infinity, -Infinity, null, undefined]) {
      expect(formatDuration(v as number)).toBe("—");
    }
  });

  it("formatDuration pads seconds and rolls minutes", () => {
    expect(formatDuration(329_000)).toBe("5:29");
    expect(formatDuration(59_500)).toBe("1:00"); // rounds to 60s, must not render "0:60"
    expect(formatDuration(1)).toBe("0:00");
    expect(formatDuration(3_600_000)).toBe("60:00");
  });

  it("formatListenTime clamps sub-minute and negative totals", () => {
    expect(formatListenTime(0)).toBe("<1m");
    expect(formatListenTime(29_000)).toBe("<1m");
    expect(formatListenTime(-60_000)).toBe("<1m");
    expect(formatListenTime(45 * 60_000)).toBe("45m");
    expect(formatListenTime((2 * 60 + 14) * 60_000)).toBe("2h 14m");
    expect(formatListenTime(60 * 60_000)).toBe("1h 0m");
  });

  it("timeAgo renders the dash for an unparseable stamp", () => {
    // "unparseable input used to render 'NaNmo ago'" (format.ts:32)
    for (const v of ["", "not-a-date", "2026-13-45"]) expect(timeAgo(v)).toBe("—");
  });

  it("timeAgo bucket boundaries", () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(timeAgo(at(0))).toBe("just now");
    expect(timeAgo(at(59_000))).toBe("just now");
    expect(timeAgo(at(60_000))).toBe("1m ago");
    expect(timeAgo(at(3_600_000))).toBe("1h ago");
    expect(timeAgo(at(24 * 3_600_000))).toBe("1d ago");
    expect(timeAgo(at(7 * 24 * 3_600_000))).toBe("1w ago");
    expect(timeAgo(at(30 * 24 * 3_600_000))).toBe("1mo ago");
  });

  it("dayLabel names today and yesterday from the local calendar", () => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = new Date();
    const yest = new Date(today);
    yest.setDate(yest.getDate() - 1);
    expect(dayLabel(local(today))).toBe("Today");
    expect(dayLabel(local(yest))).toBe("Yesterday");
  });

  it("dayLabel does not render the string 'Invalid Date' to the user", () => {
    // A day key that never reached the payload (empty string, a stray "all") must degrade to
    // something printable rather than leaking the Date coercion.
    for (const v of ["", "all", "not-a-day"]) expect(dayLabel(v)).not.toMatch(/Invalid Date/);
  });

  it("shortDate is unpadded m/d/yy", () => {
    expect(shortDate("2026-06-08T12:00:00")).toBe("6/8/26");
  });
});

// ---------------------------------------------------------------- filter.ts

describe("filter.ts fuzzyFilter", () => {
  const names = (xs: { n: string }[]) => xs.map((x) => x.n);
  const items = [
    { n: "older chinese parse" },
    { n: "Chinese Old Songs" },
    { n: "something else" },
    { n: "old chinese" },
  ];

  it("an empty or whitespace-only query returns the input untouched", () => {
    // "const q = query.trim().toLowerCase(); if (!q) return items" (filter.ts:7-8)
    expect(fuzzyFilter(items, "", (t) => t.n)).toBe(items);
    expect(fuzzyFilter(items, "   ", (t) => t.n)).toBe(items);
    expect(fuzzyFilter(items, "\t\n ", (t) => t.n)).toBe(items);
  });

  it("every token must appear, order-independently", () => {
    // "Each whitespace-separated token must appear somewhere in the name
    //  (order-independent), so 'old chinese' still matches 'older chinese parse'"
    const out = fuzzyFilter(items, "old chinese", (t) => t.n);
    expect(names(out)).toContain("older chinese parse");
    expect(names(out)).toContain("old chinese");
    expect(names(out)).toContain("Chinese Old Songs");
    expect(names(out)).not.toContain("something else");
  });

  it("ranks contiguous match, then first-token prefix, then the rest", () => {
    // "Ranking: a contiguous match of the whole query first, then names that start with the
    //  first token, then the rest." (filter.ts:4-5)
    const out = names(fuzzyFilter(items, "old chinese", (t) => t.n));
    expect(out[0]).toBe("old chinese"); // contiguous
    expect(out[1]).toBe("older chinese parse"); // starts with "old"
    expect(out[2]).toBe("Chinese Old Songs"); // neither
  });

  it("is stable within a rank tier", () => {
    const tied = [{ n: "zz alpha" }, { n: "yy alpha" }, { n: "xx alpha" }];
    expect(names(fuzzyFilter(tied, "alpha", (t) => t.n))).toEqual(["zz alpha", "yy alpha", "xx alpha"]);
  });

  it("collapses runs of whitespace between tokens", () => {
    expect(names(fuzzyFilter(items, "  old    chinese  ", (t) => t.n))).toContain("old chinese");
  });

  it("does not mutate or alias the caller's array when filtering", () => {
    const src = [...items];
    const out = fuzzyFilter(src, "chinese", (t) => t.n);
    expect(src).toEqual(items);
    expect(out).not.toBe(src);
  });
});

// ---------------------------------------------------------------- domain.ts

describe("spotify/domain.ts", () => {
  it("keyOf is case-insensitive on both halves", () => {
    // "two tracks are 'the same song' when their (primary artist, title) match,
    //  case-insensitively — NOT by Spotify id" (domain.ts:4-5)
    expect(keyOf(track({ artist: "ARTIST", title: "TITLE" }))).toBe(
      keyOf(track({ artist: "artist", title: "title" })),
    );
  });

  it("keyOf is injective over (artist, title) — a separator inside a name cannot collide", () => {
    // The key is `${artist}\x00${title}`; a name containing the separator lets two DIFFERENT
    // (artist, title) pairs produce one key, and dedupeByKey then drops a distinct song.
    const a = track({ id: "a", artist: "a\x00b", title: "c" });
    const b = track({ id: "b", artist: "a", title: "b\x00c" });
    expect(keyOf(a)).not.toBe(keyOf(b));
    expect(dedupeByKey([a, b]).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("keyOf deliberately does NOT apply Unicode full case folding (ß stays distinct)", () => {
    // ADJUDICATED 2026-08-20: expectation was wrong — identity uses JS toLowerCase by
    // design (domain.ts docstring now says so): both sides of every comparison carry
    // Spotify's own metadata, so locale folding would only invent matches Spotify itself
    // doesn't make.
    expect(keyOf(track({ title: "STRASSE" }))).not.toBe(keyOf(track({ title: "Straße" })));
  });

  it("dedupeByKey keeps the FIRST occurrence", () => {
    // "Keep the first occurrence of each (artist, title)." (domain.ts:14)
    const out = dedupeByKey([
      track({ id: "first", uri: "u1" }),
      track({ id: "second", uri: "u2" }),
      track({ id: "third", artist: "Other" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["first", "third"]);
    expect(out[0].uri).toBe("u1");
  });

  it("dedupeByKey preserves input order and does not mutate the input", () => {
    const src = [track({ id: "a" }), track({ id: "b", title: "B" }), track({ id: "c", title: "C" })];
    const snapshot = JSON.parse(JSON.stringify(src));
    const out = dedupeByKey(src);
    expect(out.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(src).toEqual(snapshot);
    expect(out).not.toBe(src);
  });

  it("dedupeByKey handles empty names without collapsing distinct songs", () => {
    const a = track({ id: "a", artist: "", title: "X" });
    const b = track({ id: "b", artist: "X", title: "" });
    expect(dedupeByKey([a, b]).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("mergeUnique concatenates in list order then dedupes", () => {
    const out = mergeUnique([
      [track({ id: "1", title: "A" }), track({ id: "2", title: "B" })],
      [track({ id: "3", title: "b" }), track({ id: "4", title: "C" })],
    ]);
    expect(out.map((t) => t.id)).toEqual(["1", "2", "4"]);
  });

  it("subtract and intersect dedupe the left side and partition it", () => {
    const left = [
      track({ id: "1", title: "A" }),
      track({ id: "2", title: "a" }), // dupe of A
      track({ id: "3", title: "B" }),
    ];
    const right = [track({ id: "9", title: "A" })];
    expect(subtract(left, right).map((t) => t.id)).toEqual(["3"]);
    expect(intersect(left, right).map((t) => t.id)).toEqual(["1"]);
    expect(subtract(left, right).length + intersect(left, right).length).toBe(
      dedupeByKey(left).length,
    );
  });

  it("subtract/intersect against an empty other list", () => {
    const left = [track({ id: "1" })];
    expect(subtract(left, []).map((t) => t.id)).toEqual(["1"]);
    expect(intersect(left, [])).toEqual([]);
  });

  it("findDuplicates returns every occurrence AFTER the first", () => {
    // "every track after the first that shares an (artist, title) with an earlier one"
    const out = findDuplicates([
      track({ id: "1", title: "A" }),
      track({ id: "2", title: "a" }),
      track({ id: "3", title: "A " }), // trailing space = a different title
      track({ id: "4", title: "A" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["2", "4"]);
  });
});

// ---------------------------------------------------------------- store-diff.ts

describe("store-diff.ts tracksNeedingWrite", () => {
  const tf = (over: Partial<TrackFields> = {}): TrackFields => ({
    id: "t1",
    name: "Name",
    artist: "Artist",
    uri: "spotify:track:t1",
    album: "Album",
    albumImage: "img",
    durationMs: 1000,
    ...over,
  });

  it("a uri-only difference is NOT a write", () => {
    // "`uri` is intentionally NOT compared — the existing upserts never update it on
    //  conflict, so a uri-only difference would rewrite the row every sync forever."
    // (store-diff.ts:18-21)
    const cached = new Map([["t1", tf({ uri: "spotify:track:OLD" })]]);
    expect(tracksNeedingWrite([tf()], cached)).toEqual([]);
  });

  it("an identical row is not a write; each compared field is", () => {
    const cached = new Map([["t1", tf()]]);
    expect(tracksNeedingWrite([tf()], cached)).toEqual([]);
    for (const change of [
      { name: "Other" },
      { artist: "Other" },
      { album: "Other" },
      { albumImage: "other" },
      { durationMs: 2000 },
    ]) {
      expect(tracksNeedingWrite([tf(change)], cached)).toHaveLength(1);
    }
  });

  it("treats undefined and null as the same absent value", () => {
    const cached = new Map([["t1", tf({ album: null, albumImage: null, durationMs: null })]]);
    const incoming = { ...tf(), album: undefined, albumImage: undefined, durationMs: undefined };
    expect(tracksNeedingWrite([incoming as unknown as TrackFields], cached)).toEqual([]);
  });

  it("an uncached track is always a write", () => {
    expect(tracksNeedingWrite([tf()], new Map())).toHaveLength(1);
  });

  it("dedupes by id — a repeated track yields at most one row", () => {
    // "Dedupes by id (the same track appears repeatedly in a recently-played batch)."
    const out = tracksNeedingWrite([tf(), tf(), tf()], new Map());
    expect(out).toHaveLength(1);
  });

  it("first copy wins when a batch repeats an id (documented; later-copy divergence is a Spotify anomaly)", () => {
    // ADJUDICATED 2026-08-20: expectation was over-strict. Spotify repeats identical
    // metadata for a repeated id within one batch; first-copy-wins is the documented
    // dedupe (store-diff.ts docstring) and a divergent later copy is not a real input.
    const cached = new Map([["t1", tf()]]);
    const out = tracksNeedingWrite([tf(), tf({ name: "Renamed" })], cached);
    expect(out).toHaveLength(0); // first copy matches the cache → no write
  });
});

describe("store-diff.ts playKey / newPlays", () => {
  it("playKey is stable and distinguishes both halves", () => {
    // Unlike keyOf, both halves come from machine-generated values (a base62 Spotify id and
    // an ISO stamp), so the "\n" separator cannot appear inside either — no injectivity test.
    expect(playKey({ trackId: "a", playedAt: "b" })).toBe(playKey({ trackId: "a", playedAt: "b" }));
    expect(playKey({ trackId: "a", playedAt: "b" })).not.toBe(
      playKey({ trackId: "b", playedAt: "a" }),
    );
  });

  it("newPlays keeps only unrecorded plays, in order", () => {
    const incoming = [
      { trackId: "a", playedAt: "1" },
      { trackId: "b", playedAt: "2" },
      { trackId: "a", playedAt: "3" },
    ];
    const existing = new Set([playKey({ trackId: "b", playedAt: "2" })]);
    expect(newPlays(incoming, existing)).toEqual([incoming[0], incoming[2]]);
  });
});

describe("store-diff.ts diffPositions", () => {
  const p = (id: string, addedAt: string | null = null): PositionRow => ({ trackId: id, addedAt });

  it("an unchanged list touches nothing", () => {
    // "an unchanged list touches nothing" (store-diff.ts:62-64)
    const list = [p("a"), p("b"), p("c")];
    expect(diffPositions(list, [...list])).toEqual({ changed: [], deleteFrom: null });
  });

  it("an append touches only the new positions", () => {
    const cached = [p("a"), p("b")];
    expect(diffPositions([p("a"), p("b"), p("c"), p("d")], cached)).toEqual({
      changed: [2, 3],
      deleteFrom: null,
    });
  });

  it("a mid-list removal rewrites just the shifted tail and trims", () => {
    const cached = [p("a"), p("b"), p("c"), p("d")];
    expect(diffPositions([p("a"), p("c"), p("d")], cached)).toEqual({
      changed: [1, 2],
      deleteFrom: 3,
    });
  });

  it("a prepend shifts everything", () => {
    const cached = [p("a"), p("b")];
    expect(diffPositions([p("z"), p("a"), p("b")], cached)).toEqual({
      changed: [0, 1, 2],
      deleteFrom: null,
    });
  });

  it("emptying the list deletes from 0 and changes nothing", () => {
    expect(diffPositions([], [p("a"), p("b")])).toEqual({ changed: [], deleteFrom: 0 });
  });

  it("an addedAt-only change at one position rewrites only that position", () => {
    const cached = [p("a", "2026-01-01"), p("b", "2026-01-02")];
    expect(diffPositions([p("a", "2026-01-01"), p("b", "2026-06-06")], cached)).toEqual({
      changed: [1],
      deleteFrom: null,
    });
  });

  it("null and undefined addedAt are the same absent value", () => {
    const cached = [{ trackId: "a", addedAt: null }];
    const incoming = [{ trackId: "a" } as unknown as PositionRow];
    expect(diffPositions(incoming, cached)).toEqual({ changed: [], deleteFrom: null });
  });

  it("duplicate track ids at different positions are diffed positionally", () => {
    const cached = [p("a"), p("a"), p("b")];
    expect(diffPositions([p("a"), p("b"), p("a")], cached).changed).toEqual([1, 2]);
  });
});

describe("store-diff.ts diffPlaylistList", () => {
  const pl = (over: Partial<PlaylistListRow> = {}): PlaylistListRow => ({
    id: "p1",
    name: "Name",
    ownerId: "me",
    image: "https://mosaic.scdn.co/a",
    trackCount: 10,
    ...over,
  });

  it("identical lists are `unchanged` with no image changes and no id-set move", () => {
    const list = [pl(), pl({ id: "p2" })];
    const d = diffPlaylistList(list, list.map((r) => ({ ...r })));
    expect(d.tier).toBe("unchanged");
    expect(d.imageChanges).toEqual([]);
    expect(d.idSetChanged).toBe(false);
    expect(d.firstDiff).toBeNull();
  });

  it("an image-only difference is its OWN tier", () => {
    // "An image difference alone is therefore its OWN tier" (store-diff.ts:136-139)
    const cached = [pl(), pl({ id: "p2" })];
    const incoming = [pl({ image: "https://mosaic.scdn.co/ROTATED" }), pl({ id: "p2" })];
    const d = diffPlaylistList(incoming, cached);
    expect(d.tier).toBe("image-only");
    expect(d.imageChanges).toEqual([{ id: "p1", image: "https://mosaic.scdn.co/ROTATED" }]);
    expect(d.idSetChanged).toBe(false);
    expect(d.firstDiff?.field).toBe("image");
  });

  it("a REORDER is structural and still rewrites", () => {
    // "Any other difference — including a reorder, which moves the stored `position` column
    //  — is structural and still rewrites." (store-diff.ts:138-139)
    const a = pl({ id: "p1" });
    const b = pl({ id: "p2" });
    const d = diffPlaylistList([b, a], [a, b]);
    expect(d.tier).toBe("rewrite");
    expect(d.idSetChanged).toBe(false);
  });

  it("a rename, an owner change and a trackCount drift are all structural", () => {
    const cached = [pl()];
    for (const change of [{ name: "Renamed" }, { ownerId: "someone" }, { trackCount: 11 }]) {
      expect(diffPlaylistList([pl(change)], cached).tier).toBe("rewrite");
    }
  });

  it("trackCount compares numerically-as-string, so a stringy cache is not a diff", () => {
    const cached = [pl({ trackCount: "10" as unknown as number })];
    expect(diffPlaylistList([pl({ trackCount: 10 })], cached).tier).toBe("unchanged");
  });

  it("a length change is structural and names the `count` field", () => {
    const d = diffPlaylistList([pl(), pl({ id: "p2" })], [pl()]);
    expect(d.tier).toBe("rewrite");
    expect(d.firstDiff?.field).toBe("count");
    expect(d.idSetChanged).toBe(true);
  });

  it("firstDiff names the field a reader would have hit first", () => {
    // "Compared in the probe's original order" (store-diff.ts:162-163): id, name, ownerId,
    // image, trackCount — and row 0 before row 1.
    const cached = [pl(), pl({ id: "p2" })];
    const incoming = [pl({ image: "other" }), pl({ id: "p2", name: "Renamed" })];
    expect(diffPlaylistList(incoming, cached).firstDiff).toMatchObject({
      playlistId: "p1",
      field: "image",
    });
    const both = diffPlaylistList([pl({ name: "Renamed", image: "other" })], [pl()]);
    expect(both.firstDiff?.field).toBe("name");
  });

  it("firstDiff truncates long values", () => {
    const long = "x".repeat(200);
    const d = diffPlaylistList([pl({ name: long })], [pl()]);
    expect(d.firstDiff?.incoming?.length).toBeLessThanOrEqual(81);
    expect(d.firstDiff?.incoming?.endsWith("…")).toBe(true);
  });

  it("idSetChanged is true when the ID SETS differ, even with equal lengths", () => {
    // "Do the cached and incoming ID SETS differ? This — not 'did anything change' — is what
    //  says playlist MEMBERSHIP could have moved, and it gates the full orphan pass."
    // (store-diff.ts:109-112)
    expect(diffPlaylistList([pl({ id: "p1" }), pl({ id: "p3" })], [pl({ id: "p1" }), pl({ id: "p2" })]).idSetChanged).toBe(
      true,
    );
  });

  it("idSetChanged is true when a duplicated id masks a removal", () => {
    // Incoming set {p1}, cached set {p1, p2}: p2 is gone, so membership moved. A paginated
    // /me/playlists race that repeats an entry across pages produces exactly this shape, and
    // needsFullOrphanPass then skips the pass for "a playlist removed whose tracks were never
    // cached" — the case store-diff.ts:195-198 says idSetChanged exists to cover.
    const d = diffPlaylistList([pl({ id: "p1" }), pl({ id: "p1" })], [pl({ id: "p1" }), pl({ id: "p2" })]);
    expect(d.idSetChanged).toBe(true);
    expect(needsFullOrphanPass(d.idSetChanged, 0)).toBe(true);
  });

  it("both empty is unchanged; empty incoming against a cache is a rewrite", () => {
    expect(diffPlaylistList([], []).tier).toBe("unchanged");
    expect(diffPlaylistList([], [pl()]).tier).toBe("rewrite");
    expect(diffPlaylistList([], [pl()]).idSetChanged).toBe(true);
  });
});

describe("store-diff.ts needsFullOrphanPass", () => {
  it("fires on either condition, not both", () => {
    expect(needsFullOrphanPass(false, 0)).toBe(false);
    expect(needsFullOrphanPass(true, 0)).toBe(true);
    expect(needsFullOrphanPass(false, 1)).toBe(true);
    expect(needsFullOrphanPass(true, 1)).toBe(true);
  });
});

describe("store-diff.ts diffKeyed", () => {
  const k = (trackId: string, position: number, addedAt: string | null = null) => ({
    trackId,
    position,
    addedAt,
  });

  it("an unchanged list writes and deletes nothing", () => {
    const list = [k("a", 0), k("b", 1)];
    expect(diffKeyed(list, list.map((r) => ({ ...r })))).toEqual({ upserts: [], deletes: [] });
  });

  it("position and addedAt changes upsert; vanished ids delete", () => {
    const cached = [k("a", 0), k("b", 1), k("c", 2)];
    const incoming = [k("a", 0), k("c", 1), k("d", 2, "2026-01-01")];
    const d = diffKeyed(incoming, cached);
    expect(d.upserts.map((r) => r.trackId)).toEqual(["c", "d"]);
    expect(d.deletes).toEqual(["b"]);
  });

  it("an id present in both is never also deleted", () => {
    const cached = [k("a", 0)];
    const incoming = [k("a", 5)];
    const d = diffKeyed(incoming, cached);
    expect(d.deletes).toEqual([]);
    expect(d.upserts).toHaveLength(1);
  });
});
