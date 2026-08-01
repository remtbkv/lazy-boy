// Known-answer tests for the store diff helpers (run: node --test src/lib/store-diff.test.ts).
// These guard the row-write-quota math: a steady-state sync where nothing changed must
// produce ZERO writes from each helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tracksNeedingWrite,
  newPlays,
  diffPositions,
  diffKeyed,
  type TrackFields,
} from "./store-diff.ts";

const track = (id: string, over: Partial<TrackFields> = {}): TrackFields => ({
  id,
  name: `name-${id}`,
  artist: `artist-${id}`,
  uri: `spotify:track:${id}`,
  album: "album",
  albumImage: "img",
  durationMs: 1000,
  ...over,
});

test("tracksNeedingWrite: identical cached rows → no writes", () => {
  const inc = [track("a"), track("b")];
  const cached = new Map(inc.map((t) => [t.id, { ...t }]));
  assert.deepEqual(tracksNeedingWrite(inc, cached), []);
});

test("tracksNeedingWrite: missing and changed rows are written, uri-only change is not", () => {
  const inc = [
    track("a"), // unchanged
    track("b", { name: "renamed" }), // changed field the upsert updates
    track("c", { uri: "spotify:track:relinked" }), // uri isn't updated on conflict → no write
    track("d"), // not cached at all
  ];
  const cached = new Map([
    ["a", track("a")],
    ["b", track("b")],
    ["c", track("c")],
  ]);
  assert.deepEqual(
    tracksNeedingWrite(inc, cached).map((t) => t.id),
    ["b", "d"],
  );
});

test("tracksNeedingWrite: null vs missing album fields compare equal; dedupes repeat ids", () => {
  const inc = [
    track("a", { album: null, albumImage: null, durationMs: null }),
    track("a", { album: null, albumImage: null, durationMs: null }), // same track played twice
  ];
  const cached = new Map([["a", track("a", { album: null, albumImage: null, durationMs: null })]]);
  assert.deepEqual(tracksNeedingWrite(inc, cached), []);
  assert.equal(tracksNeedingWrite(inc, new Map()).length, 1); // uncached → written once
});

test("newPlays: already-recorded plays are dropped, new ones kept", () => {
  const plays = [
    { trackId: "a", playedAt: "2026-07-30T01:00:00Z" },
    { trackId: "a", playedAt: "2026-07-30T02:00:00Z" },
    { trackId: "b", playedAt: "2026-07-30T01:00:00Z" },
  ];
  const existing = new Set(["a\n2026-07-30T01:00:00Z"]);
  assert.deepEqual(newPlays(plays, existing), [plays[1], plays[2]]);
});

test("diffPositions: identical list → no writes, no delete", () => {
  const list = [
    { trackId: "a", addedAt: "t1" },
    { trackId: "b", addedAt: null },
  ];
  assert.deepEqual(diffPositions(list, list.map((r) => ({ ...r }))), {
    changed: [],
    deleteFrom: null,
  });
});

test("diffPositions: append touches only the new tail", () => {
  const cached = [{ trackId: "a", addedAt: "t1" }];
  const inc = [...cached, { trackId: "b", addedAt: "t2" }];
  assert.deepEqual(diffPositions(inc, cached), { changed: [1], deleteFrom: null });
});

test("diffPositions: mid-list removal rewrites the shifted tail and trims the end", () => {
  const cached = [
    { trackId: "a", addedAt: null },
    { trackId: "b", addedAt: null },
    { trackId: "c", addedAt: null },
  ];
  const inc = [
    { trackId: "a", addedAt: null },
    { trackId: "c", addedAt: null },
  ];
  assert.deepEqual(diffPositions(inc, cached), { changed: [1], deleteFrom: 2 });
});

test("diffKeyed: identical → nothing; changed/added upserted; removed deleted", () => {
  const cached = [
    { trackId: "a", addedAt: "t1", position: 0 },
    { trackId: "b", addedAt: "t2", position: 1 },
  ];
  assert.deepEqual(diffKeyed(cached.map((r) => ({ ...r })), cached), {
    upserts: [],
    deletes: [],
  });
  const inc = [
    { trackId: "c", addedAt: "t0", position: 0 }, // new like → prepended
    { trackId: "a", addedAt: "t1", position: 1 }, // shifted position → rewritten
    // b removed
  ];
  assert.deepEqual(diffKeyed(inc, cached), { upserts: inc, deletes: ["b"] });
});
