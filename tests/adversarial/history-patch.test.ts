// ADVERSARIAL — src/lib/history-patch.ts
// Expectations come from the file's docstrings (lines 1-11, 31-33, 45-51, 57-63, 88) and
// from what history-days.ts (its only consumer's sibling) documents that it relies on.

import { describe, expect, it } from "vitest";
import {
  patchHistoryPayload,
  type HistoryPayloadShape,
  type NewPlayRow,
} from "@/lib/history-patch";

const MIN = (iso: string) => Math.floor(Date.parse(iso) / 60000);

const play = (over: Partial<NewPlayRow> = {}): NewPlayRow => ({
  name: "Song",
  artist: "Artist",
  album: "Album",
  albumImage: "img",
  durationMs: 200_000,
  lastPlayed: "2026-08-20T12:00:00.000Z",
  source: "playlist:X",
  ...over,
});

const empty = (): HistoryPayloadShape => ({
  images: [],
  albums: [],
  sources: [],
  tracks: [],
  plays: [],
});

describe("patchHistoryPayload — purity", () => {
  it("never mutates the input payload, deeply", () => {
    const hist: HistoryPayloadShape = {
      images: ["i0"],
      albums: ["a0"],
      sources: ["s0"],
      tracks: [["Old", "Band", 0, 0, 1000]],
      plays: [[0, MIN("2026-08-20T11:00:00.000Z"), 0]],
    };
    const before = JSON.parse(JSON.stringify(hist));
    const out = patchHistoryPayload(hist, [
      play({ name: "New", artist: "Other", album: "a1", albumImage: "i1", source: "s1" }),
    ]);
    expect(hist).toEqual(before);
    expect(out).not.toBe(hist);
    expect(out.tracks).not.toBe(hist.tracks);
    expect(out.images).not.toBe(hist.images);
    expect(out.albums).not.toBe(hist.albums);
    expect(out.sources).not.toBe(hist.sources);
    expect(out.plays).not.toBe(hist.plays);
  });

  it("does not mutate the input when the delta is empty", () => {
    const hist: HistoryPayloadShape = {
      images: [],
      albums: [],
      sources: [],
      tracks: [["Old", "Band", -1, -1, 0]],
      plays: [[0, 100, -1]],
    };
    const before = JSON.parse(JSON.stringify(hist));
    const out = patchHistoryPayload(hist, []);
    expect(hist).toEqual(before);
    expect(out).toEqual(hist);
  });

  it("structurally shares tuples but never writes through them", () => {
    // The copies are shallow, so track tuples are aliased with the input's. That is normal
    // structural sharing and the docstring only promises "a NEW payload" (line 31) — what
    // must hold is that no existing tuple is written through.
    const hist: HistoryPayloadShape = {
      ...empty(),
      tracks: [["Old", "Band", -1, -1, 0]],
      plays: [[0, 100, -1]],
    };
    const frozen = Object.freeze(hist.tracks[0]);
    hist.tracks[0] = frozen;
    expect(() =>
      patchHistoryPayload(hist, [play({ name: "New" }), play({ name: "Old", artist: "Band" })]),
    ).not.toThrow();
  });
});

describe("patchHistoryPayload — idempotency", () => {
  it("patching the same delta twice equals patching it once (new song)", () => {
    // "plays already present ... are skipped, so re-applying an overlapping delta is
    //  idempotent" (history-patch.ts:31-33)
    const hist = empty();
    const delta = [play()];
    const once = patchHistoryPayload(hist, delta);
    const twice = patchHistoryPayload(once, delta);
    expect(twice).toEqual(once);
  });

  it("patching the same delta twice equals once (song already in the payload)", () => {
    const hist: HistoryPayloadShape = {
      images: ["img"],
      albums: ["Album"],
      sources: ["playlist:X"],
      tracks: [["Song", "Artist", 0, 0, 200_000]],
      plays: [[0, MIN("2026-08-20T10:00:00.000Z"), 0]],
    };
    const delta = [play()];
    const once = patchHistoryPayload(hist, delta);
    const twice = patchHistoryPayload(once, delta);
    expect(twice).toEqual(once);
    expect(once.plays).toHaveLength(2);
  });

  it("an OVERLAPPING delta (old play + new play) adds only the new play", () => {
    const hist = patchHistoryPayload(empty(), [play({ lastPlayed: "2026-08-20T10:00:00.000Z" })]);
    const out = patchHistoryPayload(hist, [
      play({ lastPlayed: "2026-08-20T12:00:00.000Z" }),
      play({ lastPlayed: "2026-08-20T10:00:00.000Z" }),
    ]);
    expect(out.plays).toHaveLength(2);
    expect(out.tracks).toHaveLength(1);
  });

  it("a delta repeated inside one call adds the play once", () => {
    const out = patchHistoryPayload(empty(), [play(), play(), play()]);
    expect(out.plays).toHaveLength(1);
    expect(out.tracks).toHaveLength(1);
  });

  it("never leaves an orphan track (every track index is referenced by some play)", () => {
    const hist = patchHistoryPayload(empty(), [play()]);
    const out = patchHistoryPayload(hist, [play()]); // fully redundant delta
    const referenced = new Set(out.plays.map(([t]) => t));
    out.tracks.forEach((_, i) => expect(referenced.has(i)).toBe(true));
  });
});

describe("patchHistoryPayload — identity vs index", () => {
  it("does not re-add a play the payload already holds under a SIBLING track index", () => {
    // "Seen-keys are IDENTITY:minute, not index:minute — the payload can hold the same song
    //  under two track indices (dual Spotify ids)" (history-patch.ts:57-59, audit T2.5)
    const m = MIN("2026-08-20T12:00:00.000Z");
    const hist: HistoryPayloadShape = {
      images: [],
      albums: [],
      sources: [],
      tracks: [
        ["Song", "Artist", -1, -1, 200_000], // id #1
        ["Song", "Artist", -1, -1, 200_000], // id #2, same song
      ],
      plays: [[1, m, -1]], // recorded under the SECOND index
    };
    const out = patchHistoryPayload(hist, [play({ lastPlayed: "2026-08-20T12:00:00.000Z" })]);
    expect(out.plays).toHaveLength(1);
    expect(out.tracks).toHaveLength(2);
  });

  it("a delta song differing only by case reuses the existing track, adds no duplicate", () => {
    const hist: HistoryPayloadShape = {
      ...empty(),
      tracks: [["Song", "Artist", -1, -1, 200_000]],
      plays: [[0, MIN("2026-08-20T10:00:00.000Z"), -1]],
    };
    const out = patchHistoryPayload(hist, [play({ name: "SONG", artist: "ARTIST" })]);
    expect(out.tracks).toHaveLength(1);
    expect(out.plays).toHaveLength(2);
    expect(out.plays[0][0]).toBe(0);
  });

  it("a case-only delta of a play already present is still a no-op", () => {
    const m = MIN("2026-08-20T12:00:00.000Z");
    const hist: HistoryPayloadShape = {
      ...empty(),
      tracks: [["Song", "Artist", -1, -1, 200_000]],
      plays: [[0, m, -1]],
    };
    const out = patchHistoryPayload(hist, [play({ name: "sOnG", artist: "aRtIsT" })]);
    expect(out.plays).toEqual(hist.plays);
  });
});

describe("patchHistoryPayload — interning", () => {
  it("interns null and empty string alike as -1, and never adds them to a table", () => {
    // `intern`: "if (v == null || v === '') return -1" (history-patch.ts:45-51). 0 = a real
    // table slot, so the sentinel must not collide with it.
    const out = patchHistoryPayload(empty(), [
      play({ name: "A", album: null, albumImage: "", source: "" }),
      play({ name: "B", album: "", albumImage: null, source: null }),
    ]);
    expect(out.images).toEqual([]);
    expect(out.albums).toEqual([]);
    expect(out.sources).toEqual([]);
    for (const [, , img, alb] of out.tracks) {
      expect(img).toBe(-1);
      expect(alb).toBe(-1);
    }
    for (const [, , src] of out.plays) expect(src).toBe(-1);
  });

  it("reuses an existing table slot instead of appending a duplicate", () => {
    const hist: HistoryPayloadShape = { ...empty(), sources: ["playlist:X"], albums: ["Album"] };
    const out = patchHistoryPayload(hist, [play()]);
    expect(out.sources).toEqual(["playlist:X"]);
    expect(out.albums).toEqual(["Album"]);
    expect(out.plays[0][2]).toBe(0);
  });

  it("durationMs null becomes the documented 0 = unknown sentinel", () => {
    // "0 = unknown, the same convention the server-built payload uses" (line 76)
    const out = patchHistoryPayload(empty(), [play({ durationMs: null })]);
    expect(out.tracks[0][4]).toBe(0);
  });

  it("does not intern a source for a play it skips", () => {
    const m = MIN("2026-08-20T12:00:00.000Z");
    const hist: HistoryPayloadShape = {
      ...empty(),
      tracks: [["Song", "Artist", -1, -1, 0]],
      plays: [[0, m, -1]],
    };
    const out = patchHistoryPayload(hist, [play({ source: "playlist:NEW" })]);
    expect(out.sources).toEqual([]);
  });
});

describe("patchHistoryPayload — ordering", () => {
  it("the returned plays list is newest-first", () => {
    // "Both lists are newest-first; the delta is by construction newer than the payload."
    // (history-patch.ts:88). buildDays depends on this in three places: latestSource picks
    // "the first one seen for a song" (history-days.ts:46-53), the per-day fold assumes the
    // row is created from the day's LAST play (history-days.ts:86-90), and `newest` is
    // localDay(plays[0]) (history-days.ts:119). A delta carrying a backfilled older play —
    // exactly what scripts/backfill-from-backstop.mjs replays into the store — makes the
    // merged list non-monotonic and silently corrupts all three.
    const hist = patchHistoryPayload(empty(), [
      play({ name: "Recent", lastPlayed: "2026-08-20T12:00:00.000Z" }),
    ]);
    const out = patchHistoryPayload(hist, [
      play({ name: "Backfilled", lastPlayed: "2026-08-19T03:00:00.000Z" }),
    ]);
    const minutes = out.plays.map(([, m]) => m);
    for (let i = 1; i < minutes.length; i++) {
      expect(minutes[i - 1]).toBeGreaterThanOrEqual(minutes[i]);
    }
  });

  it("an internally out-of-order delta still yields a newest-first payload", () => {
    const out = patchHistoryPayload(empty(), [
      play({ name: "Older", lastPlayed: "2026-08-20T09:00:00.000Z" }),
      play({ name: "Newer", lastPlayed: "2026-08-20T12:00:00.000Z" }),
    ]);
    const minutes = out.plays.map(([, m]) => m);
    for (let i = 1; i < minutes.length; i++) {
      expect(minutes[i - 1]).toBeGreaterThanOrEqual(minutes[i]);
    }
  });
});
