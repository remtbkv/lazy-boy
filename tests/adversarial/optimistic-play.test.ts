// ADVERSARIAL — src/lib/optimistic-play.ts
// Expectations are derived from the file's own contract comments (lines 1-11, 27-35,
// 40-42, 51-56, 62-72) and from db.ts's TrackStats docs. Nothing here is derived from
// observed output.

import { describe, expect, it } from "vitest";
import {
  addPlay,
  reconcilePlays,
  PROVISIONAL_TTL_MS,
  type PlayRow,
  type Provisional,
} from "@/lib/optimistic-play";

const row = (over: Partial<PlayRow> = {}): PlayRow => ({
  id: "id",
  name: "Song",
  artist: "Artist",
  uri: "spotify:track:1",
  album: "Album",
  albumImage: null,
  durationMs: 200_000,
  plays: 1,
  lastPlayed: "2026-08-20T12:00:00.000Z",
  firstPlayed: "2026-08-20T12:00:00.000Z",
  source: null,
  ...over,
});

const prov = (
  at: number,
  over: Partial<PlayRow> = {},
  day = "2026-08-20",
  basePlays = 0,
): Provisional => ({
  row: row(over),
  at,
  day,
  basePlays,
});

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

describe("addPlay", () => {
  it("on empty rows yields exactly the provisional row", () => {
    // "a new song gets a fresh row" (optimistic-play.ts:40-42)
    const p = row({ name: "New", plays: 1 });
    expect(addPlay([], p)).toEqual([p]);
  });

  it("does not mutate the input array or its rows", () => {
    // "Pure — returns a new array." (optimistic-play.ts:41-42)
    const existing = row({ plays: 3 });
    const rows = [existing];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const out = addPlay(rows, row({ lastPlayed: "2026-08-20T13:00:00.000Z" }));
    expect(rows).toEqual(snapshot);
    expect(out).not.toBe(rows);
    expect(out[0]).not.toBe(existing);
  });

  it("matches by case-insensitive (artist, title) identity, not by id/uri", () => {
    // identity() lowercases both halves (optimistic-play.ts:37-38)
    const rows = [row({ id: "a", name: "SONG", artist: "ARTIST", plays: 2 })];
    const out = addPlay(rows, row({ id: "b", name: "song", artist: "artist" }));
    expect(out).toHaveLength(1);
    expect(out[0].plays).toBe(3);
  });

  it("never moves lastPlayed backwards when the existing row is newer", () => {
    // "Newest-wins: unconditionally taking the provisional's stamp could move a row's
    //  timestamp BACKWARDS" (optimistic-play.ts:51-56)
    const rows = [row({ lastPlayed: "2026-08-20T15:00:00.000Z", plays: 4 })];
    const out = addPlay(rows, row({ lastPlayed: "2026-08-20T09:00:00.000Z" }));
    expect(out[0].lastPlayed).toBe("2026-08-20T15:00:00.000Z");
    expect(out[0].plays).toBe(5);
  });

  it("takes the provisional stamp when it is newer, and on an exact tie", () => {
    const rows = [row({ lastPlayed: "2026-08-20T09:00:00.000Z" })];
    expect(addPlay(rows, row({ lastPlayed: "2026-08-20T15:00:00.000Z" }))[0].lastPlayed).toBe(
      "2026-08-20T15:00:00.000Z",
    );
    // Equal stamps: `>=` keeps the provisional's string; must still be the same instant.
    const tie = addPlay(rows, row({ lastPlayed: "2026-08-20T09:00:00.000Z" }));
    expect(Date.parse(tie[0].lastPlayed)).toBe(Date.parse("2026-08-20T09:00:00.000Z"));
  });

  it("keeps a parseable existing stamp rather than adopting an unparseable one", () => {
    // Monotonicity must not be defeated by a junk stamp on either side.
    const rows = [row({ lastPlayed: "2026-08-20T15:00:00.000Z" })];
    const out = addPlay(rows, row({ lastPlayed: "not-a-date" }));
    expect(Number.isNaN(Date.parse(out[0].lastPlayed))).toBe(false);
  });

  it("never produces a negative or fractional play count", () => {
    const rows = [row({ plays: 0 })];
    expect(addPlay(rows, row())[0].plays).toBe(1);
    expect(addPlay([], row({ plays: 1 }))[0].plays).toBeGreaterThanOrEqual(0);
  });
});

describe("reconcilePlays — structural invariants", () => {
  it("remaining is a subset of the input provisionals (same object identities)", () => {
    const provs = [
      prov(NOW - 1_000, { name: "A" }),
      prov(NOW - 2_000, { name: "B" }),
      prov(NOW - PROVISIONAL_TTL_MS - 1, { name: "C" }),
    ];
    const { remaining } = reconcilePlays([], provs, NOW);
    for (const r of remaining) expect(provs).toContain(r);
    expect(remaining.length).toBeLessThanOrEqual(provs.length);
  });

  it("prunes expired provisionals even when a server row would confirm them", () => {
    // "expired: presumed never recorded" (optimistic-play.ts:82) — an expired provisional
    // must leave `remaining` regardless of the server's answer.
    const p = prov(NOW - PROVISIONAL_TTL_MS - 1);
    const server = [row({ lastPlayed: new Date(NOW).toISOString() })];
    const a = reconcilePlays(server, [p], NOW);
    expect(a.remaining).toEqual([]);
    const b = reconcilePlays([], [p], NOW);
    expect(b.remaining).toEqual([]);
    expect(b.rows).toEqual([]);
  });

  it("keeps a provisional at exactly PROVISIONAL_TTL_MS (expiry is strictly older)", () => {
    const p = prov(NOW - PROVISIONAL_TTL_MS);
    expect(reconcilePlays([], [p], NOW).remaining).toEqual([p]);
  });

  it("never re-applies a confirmed provisional", () => {
    // ADJUDICATED 2026-08-20: confirmation = the song's count exceeding basePlays
    // (optimistic-play.ts Provisional docstring); the server row then wins untouched.
    const server = [row({ plays: 7, lastPlayed: new Date(NOW).toISOString() })];
    const { rows, remaining } = reconcilePlays(server, [prov(NOW - 5_000, {}, "2026-08-20", 6)], NOW);
    expect(rows).toBe(server); // untouched server truth
    expect(rows[0].plays).toBe(7);
    expect(remaining).toEqual([]);
  });

  it("does not mutate serverRows", () => {
    const server = [row({ plays: 2 })];
    const snapshot = JSON.parse(JSON.stringify(server));
    reconcilePlays(server, [prov(NOW - 1_000, { name: "Other" })], NOW);
    expect(server).toEqual(snapshot);
  });

  it("re-applies an unconfirmed provisional and keeps counts non-negative", () => {
    const { rows, remaining } = reconcilePlays([], [prov(NOW - 1_000)], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].plays).toBe(1);
    expect(remaining).toHaveLength(1);
    for (const r of rows) expect(r.plays).toBeGreaterThanOrEqual(0);
  });

  it("folds two unconfirmed provisionals of the same song into one row with two plays", () => {
    const provs = [prov(NOW - 1_000), prov(NOW - 2_000)];
    const { rows, remaining } = reconcilePlays([], provs, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].plays).toBe(2);
    expect(remaining).toHaveLength(2);
  });

  it("adds two unconfirmed provisionals on top of an existing server row", () => {
    // Count-based contract: both minted when the row already showed 3 → still 3 = unconfirmed.
    const server = [row({ plays: 3, lastPlayed: new Date(NOW - 600_000).toISOString() })];
    const provs = [prov(NOW - 1_000, {}, "2026-08-20", 3), prov(NOW - 2_000, {}, "2026-08-20", 3)];
    const { rows } = reconcilePlays(server, provs, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].plays).toBe(5);
  });
});

describe("reconcilePlays — confirmation (count-based, ADJUDICATED 2026-08-20)", () => {
  // The original grace-window tests here proved the two documented jobs of graceMs were
  // contradictory (A1/A2): no scalar both rejects the previous play and accepts this
  // one, because Spotify stamps played_at at track START. The judge REDESIGNED
  // confirmation to a count baseline: a provisional carries basePlays (the song's
  // today-count at mint) and is confirmed iff the server row's count exceeds it.
  // These tests pin the new contract's answers to the SAME scenarios.

  it("REPEAT PLAY: the previous play's row cannot confirm (it is inside basePlays)", () => {
    const at = NOW - 1_000;
    const server = [row({ plays: 1 })];
    const { rows, remaining } = reconcilePlays(server, [prov(at, {}, "2026-08-20", 1)], NOW);
    expect(remaining).toHaveLength(1);
    expect(rows[0].plays).toBe(2);
  });

  it("THIS play's own row confirms regardless of its timestamp shape", () => {
    const at = NOW - 1_000;
    const server = [row({ plays: 1, lastPlayed: new Date(NOW - 59_999).toISOString() })];
    expect(reconcilePlays(server, [prov(at, {}, "2026-08-20", 0)], NOW).remaining).toEqual([]);
  });

  it("a DIFFERENT song's fresh server row never confirms", () => {
    const at = NOW - 1_000;
    const server = [row({ name: "Something Else", plays: 5 })];
    expect(reconcilePlays(server, [prov(at)], NOW).remaining).toHaveLength(1);
  });

  it("a missing server row never confirms (count 0 is never > base 0)", () => {
    expect(reconcilePlays([], [prov(NOW - 1_000)], NOW).remaining).toHaveLength(1);
  });
});

