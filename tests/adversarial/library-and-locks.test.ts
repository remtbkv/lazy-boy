// Adversarial: the playlist cache's position invariant, the library-union exclusion
// contract, the unique-song count, the cross-instance lock, and the cooldown's MAX rule.
//
// Documented contract, quoted:
//   db.ts:2161-2165 (removeCachedPlaylistTrack) — "COMPACT the positions after the delete.
//     diffPositions treats the cached array's INDEX as the position value, so a gap left by
//     this delete made the next store overwrite the wrong slot (a track silently vanished
//     from the cache) or trim a live row … One correlated-subquery renumber keeps
//     index === position, which is the invariant every diff consumer assumes."
//   db.ts:2271-2280 (getLibraryTracks) — Liked Songs + every OWNED playlist; other
//     `Cleaned: …` playlists DO count; the target's own `Cleaned: <name>` does not; backups
//     (`Dupes removed from: …`) never count. names.ts:12-16 clamps the derived name to 100.
//   db.ts:1926-1933 (getUniqueSongCount) — "Count of DISTINCT songs (by case-insensitive
//     artist+title) … 0 until first cached."
//   db.ts:2533-2535 (acquireLock) — "Returns an owner token … null if the lock is held. The
//     owner check stops a holder that overran its TTL from releasing the lock someone else
//     has since acquired." db.ts:2539-2542 — same-millisecond acquisitions must not mint the
//     same token.
//   db.ts:2376-2378 (setSpotifyCooldownUntil) — "MAX, not overwrite: a later, shorter ban
//     must never SHORTEN a persisted longer one."
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  getLibraryTracks,
  getPlaylistTracks,
  getSpotifyCooldownUntil,
  getUniqueSongCount,
  recomputeUniqueSongCount,
  releaseLock,
  removeCachedPlaylistTrack,
  setSpotifyCooldownUntil,
  storePlaylists,
  storePlaylistTracks,
  storeSavedTracks,
} from "@/lib/db";
import { positions, rawClient, resetStore, sleep, track } from "./helpers";

const ids = (rows: { position: number; trackId: string }[]) => rows.map((r) => r.trackId);
/** The invariant every diff consumer assumes: positions are exactly 0..n-1, in order. */
const expectDense = (rows: { position: number; trackId: string }[]) =>
  expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));

describe("playlist_tracks positions stay dense (0..n-1) under stores and removals", () => {
  beforeEach(resetStore);

  it("holds across a scripted sequence of stores and single-track removals", async () => {
    const T = (id: string) => track(id);
    const steps: [string, () => Promise<unknown>, string[]][] = [
      [
        "initial store of 5",
        () => storePlaylistTracks("p1", ["A", "B", "C", "D", "E"].map(T)),
        ["A", "B", "C", "D", "E"],
      ],
      ["remove the middle (C)", () => removeCachedPlaylistTrack("p1", "spotify:track:C"), ["A", "B", "D", "E"]],
      [
        "store the list without C",
        () => storePlaylistTracks("p1", ["A", "B", "D", "E"].map(T)),
        ["A", "B", "D", "E"],
      ],
      ["remove the head (A)", () => removeCachedPlaylistTrack("p1", "spotify:track:A"), ["B", "D", "E"]],
      [
        "append F",
        () => storePlaylistTracks("p1", ["B", "D", "E", "F"].map(T)),
        ["B", "D", "E", "F"],
      ],
      ["remove the tail (F)", () => removeCachedPlaylistTrack("p1", "spotify:track:F"), ["B", "D", "E"]],
      [
        "store a shorter, completely different list",
        () => storePlaylistTracks("p1", ["X", "Y"].map(T)),
        ["X", "Y"],
      ],
      ["empty the playlist", () => storePlaylistTracks("p1", []), []],
      [
        "refill it",
        () => storePlaylistTracks("p1", ["A", "B", "C"].map(T)),
        ["A", "B", "C"],
      ],
    ];
    for (const [label, run, expected] of steps) {
      await run();
      const rows = await positions("p1");
      expectDense(rows);
      expect({ label, ids: ids(rows) }).toEqual({ label, ids: expected });
      expect((await getPlaylistTracks("p1")).map((t) => t.id)).toEqual(expected);
    }
  });

  it("a removal followed by a store of the ORIGINAL list restores every track", async () => {
    const list = ["A", "B", "C", "D", "E"].map((id) => track(id));
    await storePlaylistTracks("p1", list);
    await removeCachedPlaylistTrack("p1", "spotify:track:C");
    await storePlaylistTracks("p1", list);
    const rows = await positions("p1");
    expectDense(rows);
    expect(ids(rows)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("removing from one playlist leaves the other's rows and positions untouched", async () => {
    await storePlaylistTracks("p1", ["A", "B", "C"].map((id) => track(id)));
    await storePlaylistTracks("p2", ["C", "A", "D"].map((id) => track(id)));
    await removeCachedPlaylistTrack("p1", "spotify:track:C");
    const p2 = await positions("p2");
    expectDense(p2);
    expect(ids(p2)).toEqual(["C", "A", "D"]);
    expectDense(await positions("p1"));
    expect(ids(await positions("p1"))).toEqual(["A", "B"]);
  });

  it("removing a uri the playlist doesn't hold changes nothing", async () => {
    await storePlaylistTracks("p1", ["A", "B", "C"].map((id) => track(id)));
    await removeCachedPlaylistTrack("p1", "spotify:track:ZZZ");
    const rows = await positions("p1");
    expectDense(rows);
    expect(ids(rows)).toEqual(["A", "B", "C"]);
  });

  it("a playlist holding the same track twice stays dense after a removal", async () => {
    await storePlaylistTracks("p1", ["A", "B", "A", "C"].map((id) => track(id)));
    expect(ids(await positions("p1"))).toEqual(["A", "B", "A", "C"]);
    await removeCachedPlaylistTrack("p1", "spotify:track:A");
    const rows = await positions("p1");
    expectDense(rows);
    // Whatever the remove does to the duplicate, the OTHER tracks must still be cached.
    expect(ids(rows)).toEqual(expect.arrayContaining(["B", "C"]));
  });

  it("two track ids sharing one uri: positions stay dense after removing that uri", async () => {
    // Spotify hands the same song different ids across contexts (db.ts:689-693), so a uri
    // can resolve to more than one `tracks` row.
    await storePlaylistTracks("p1", [
      track("id1", { uri: "spotify:track:same" }),
      track("B"),
      track("id2", { uri: "spotify:track:same" }),
      track("C"),
    ]);
    await removeCachedPlaylistTrack("p1", "spotify:track:same");
    const rows = await positions("p1");
    expectDense(rows);
    expect(ids(rows)).toEqual(expect.arrayContaining(["B", "C"]));
  });

  it("a store after a removal never drops a track that is still in the list", async () => {
    // The wave-2 B1 failure mode, driven from a fixed pseudo-random op script (no
    // Math.random): after every op, everything the caller last stored must still be there.
    const all = ["A", "B", "C", "D", "E", "F", "G"];
    const script: (string[] | string)[] = [
      ["A", "B", "C", "D", "E"],
      "C",
      ["A", "B", "D", "E", "F"],
      "A",
      "F",
      ["B", "D", "E", "G"],
      "E",
      ["B", "D", "G", "A", "C"],
      "D",
      ["A", "C", "F", "G"],
    ];
    let expected: string[] = [];
    for (const op of script) {
      if (typeof op === "string") {
        await removeCachedPlaylistTrack("p1", `spotify:track:${op}`);
        expected = expected.filter((id) => id !== op);
      } else {
        await storePlaylistTracks("p1", op.map((id) => track(id)));
        expected = [...op];
      }
      const rows = await positions("p1");
      expectDense(rows);
      expect(ids(rows)).toEqual(expected);
      expect(all.filter((id) => !expected.includes(id)).some((id) => ids(rows).includes(id))).toBe(
        false,
      );
    }
  });
});

describe("getLibraryTracks exclusion contract", () => {
  const ME = "me";
  const LONG = "L".repeat(95); // cleanedName() clamps "Cleaned: " + this to 100 chars

  beforeEach(async () => {
    await resetStore();
    await storePlaylists(
      [
        { id: "target", name: "Target", ownerId: ME, image: null, trackCount: 2 },
        { id: "cleanedTarget", name: "Cleaned: Target", ownerId: ME, image: null, trackCount: 1 },
        { id: "backup", name: "Dupes removed from: Target", ownerId: ME, image: null, trackCount: 1 },
        { id: "cleanedOther", name: "Cleaned: Other", ownerId: ME, image: null, trackCount: 1 },
        { id: "foreign", name: "Someone else's", ownerId: "notme", image: null, trackCount: 1 },
        { id: "mine2", name: "Another of mine", ownerId: ME, image: null, trackCount: 1 },
        {
          id: "cleanedLong",
          name: `Cleaned: ${LONG}`.slice(0, 100),
          ownerId: ME,
          image: null,
          trackCount: 1,
        },
      ],
      ME,
    );
    await storePlaylistTracks("target", [track("inTarget1"), track("inTarget2")]);
    await storePlaylistTracks("cleanedTarget", [track("inOwnCleaned")]);
    await storePlaylistTracks("backup", [track("inBackup")]);
    await storePlaylistTracks("cleanedOther", [track("inOtherCleaned")]);
    await storePlaylistTracks("foreign", [track("inForeign")]);
    await storePlaylistTracks("mine2", [track("inMine2")]);
    await storePlaylistTracks("cleanedLong", [track("inLongCleaned")]);
    await storeSavedTracks([track("liked")]);
  });

  it("excludes the target, its own cleaned output and every backup; keeps the rest", async () => {
    const rows = await getLibraryTracks("target", "Target");
    // `Cleaned: <LONG>` is somebody else's clean output, so per the contract it counts.
    expect(rows.map((t) => t.id).sort()).toEqual(
      ["inLongCleaned", "inMine2", "inOtherCleaned", "liked"].sort(),
    );
  });

  it("excludes by id even when the name-based rule cannot match (wave-2 A1/A2)", async () => {
    // The stored name has drifted from the derived one (a rename between phases), so only
    // the id exclusion can hold.
    const c = await rawClient();
    await c.execute("UPDATE playlists SET name = 'Renamed by the user' WHERE id = 'cleanedTarget'");
    const rows = await getLibraryTracks("target", "Target", ["cleanedTarget"]);
    expect(rows.map((t) => t.id)).not.toContain("inOwnCleaned");
  });

  it("the name-based exclusion matches Spotify's 100-char clamp (wave-3 P1)", async () => {
    const rows = await getLibraryTracks("someOther", LONG);
    expect(rows.map((t) => t.id)).not.toContain("inLongCleaned");
  });

  it("without an exceptName nothing is excluded by name", async () => {
    const rows = await getLibraryTracks("target");
    expect(rows.map((t) => t.id).sort()).toEqual(
      ["inLongCleaned", "inMine2", "inOtherCleaned", "inOwnCleaned", "liked"].sort(),
    );
  });

  it("never returns a foreign-owner playlist's tracks", async () => {
    const rows = await getLibraryTracks();
    expect(rows.map((t) => t.id)).not.toContain("inForeign");
  });
});

describe("unique song count", () => {
  beforeEach(resetStore);

  it("is 0 until first cached, then collapses case-variant duplicates", async () => {
    expect(await getUniqueSongCount()).toBe(0);
    await storePlaylistTracks("p1", [
      track("a1", { title: "Song One", artist: "Artist X" }),
      track("a2", { title: "SONG ONE", artist: "ARTIST X" }),
      track("b1", { title: "Song Two", artist: "Artist X" }),
    ]);
    // The same two songs again in a second playlist must not double the count.
    await storePlaylistTracks("p2", [
      track("a3", { title: "song one", artist: "artist x" }),
      track("b2", { title: "Song Two", artist: "Artist X" }),
    ]);
    expect(await recomputeUniqueSongCount()).toBe(2);
    expect(await getUniqueSongCount()).toBe(2);
  });

  it("self-heals in the background after a writer the sync doesn't see (T2.3)", async () => {
    await storePlaylistTracks("p1", [
      track("a1", { title: "Song One", artist: "Artist X" }),
      track("b1", { title: "Song Two", artist: "Artist X" }),
    ]);
    expect(await recomputeUniqueSongCount()).toBe(2);
    // A single-track removal is exactly the out-of-band writer T2.3 names.
    await removeCachedPlaylistTrack("p1", "spotify:track:b1");
    // Documented: serve the cached number instantly, kick a recompute for the next render.
    expect(await getUniqueSongCount()).toBe(2);
    let healed = 0;
    for (let i = 0; i < 40 && healed !== 1; i++) {
      await sleep(25);
      healed = await getUniqueSongCount();
    }
    expect(healed).toBe(1);
  });
});

describe("cross-instance lock", () => {
  beforeEach(resetStore);
  afterEach(() => vi.useRealTimers());

  it("a held lock cannot be acquired again", async () => {
    const owner = await acquireLock("sync", 60_000);
    expect(owner).toBeTruthy();
    expect(await acquireLock("sync", 60_000)).toBeNull();
  });

  it("releasing with the wrong owner does not free it", async () => {
    const owner = await acquireLock("sync", 60_000);
    await releaseLock("sync", "not-the-owner");
    expect(await acquireLock("sync", 60_000)).toBeNull();
    await releaseLock("sync", owner as string);
    expect(await acquireLock("sync", 60_000)).toBeTruthy();
  });

  it("an expired lock is acquirable, and the old holder cannot free the new one", async () => {
    const stale = await acquireLock("sync", 30);
    await sleep(60);
    const fresh = await acquireLock("sync", 60_000);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(stale);
    await releaseLock("sync", stale as string); // the overrun holder tries to release
    expect(await acquireLock("sync", 60_000)).toBeNull(); // …and must not have succeeded
  });

  it("two acquisitions in the same millisecond mint different tokens (wave-2 B1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await acquireLock("sync", 60_000);
    await releaseLock("sync", first as string);
    const second = await acquireLock("sync", 60_000);
    expect(Date.now()).toBe(Date.now()); // frozen clock: both were minted at one instant
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("locks are independent by name and survive hostile names", async () => {
    const a = await acquireLock("a'; DELETE FROM meta;--", 60_000);
    const b = await acquireLock("другой", 60_000);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(await acquireLock("a'; DELETE FROM meta;--", 60_000)).toBeNull();
  });
});

describe("spotify cooldown is monotonic (T1.10)", () => {
  beforeEach(resetStore);

  it("never shortens a persisted longer ban", async () => {
    expect(await getSpotifyCooldownUntil()).toBe(0);
    await setSpotifyCooldownUntil(5_000);
    expect(await getSpotifyCooldownUntil()).toBe(5_000);
    await setSpotifyCooldownUntil(1_000);
    expect(await getSpotifyCooldownUntil()).toBe(5_000);
    await setSpotifyCooldownUntil(0);
    expect(await getSpotifyCooldownUntil()).toBe(5_000);
    await setSpotifyCooldownUntil(-9_000);
    expect(await getSpotifyCooldownUntil()).toBe(5_000);
    await setSpotifyCooldownUntil(9_000.9);
    expect(await getSpotifyCooldownUntil()).toBe(9_000);
    await setSpotifyCooldownUntil(9_000);
    expect(await getSpotifyCooldownUntil()).toBe(9_000);
  });

  it("is monotone under any arrival order of the same set of bans", async () => {
    const bans = [3_000, 100_000, 250, 99_999, 42];
    for (const b of [...bans].sort((x, y) => x - y)) await setSpotifyCooldownUntil(b);
    const ascending = await getSpotifyCooldownUntil();
    await resetStore();
    for (const b of [...bans].sort((x, y) => y - x)) await setSpotifyCooldownUntil(b);
    expect(await getSpotifyCooldownUntil()).toBe(ascending);
    expect(ascending).toBe(Math.max(...bans));
  });
});
