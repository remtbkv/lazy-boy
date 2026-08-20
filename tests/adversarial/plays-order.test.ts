// Adversarial: does the store's answer depend on the ORDER plays arrived in?
//
// The documented contract this file tests, quoted from source:
//   db.ts:786-790 — "Rule on every pending (skipped IS NULL) real play that now has a
//     successor: listened = min(gap to next play, duration); skipped = listened < 35% of
//     duration. Unknown duration or a clock-weird negative gap counts as not-skipped (be
//     permissive). The newest play stays pending."
//   db.ts:556-563 — an out-of-order insert "makes the row immediately before it wrong: its
//     verdict was measured against a successor that is no longer adjacent. Re-open the
//     predecessor of each such insert."
//   docs/LOGIC_AUDIT_2026-08-19.md:55-61 (T1.6) — the bug this machinery fixes.
// Together those say a verdict is a fact about the TIMELINE. So the same set of plays,
// delivered in any arrival order, must converge to the same verdicts and the same reader
// answers. That is the property below.
import { beforeEach, describe, expect, it } from "vitest";
import {
  getAllTimePlays,
  getDailyStats,
  getPlaysByDay,
  recomputeAllTimeStats,
  recordPlays,
} from "@/lib/db";
import { DAY_MS, iso, play, resetStore, verdicts } from "./helpers";

// 10:00 UTC, three days ago — recent enough that every windowed reader (readDailyStats's
// `now - (days+2)` cutoff) covers it, old enough that "today" can't drift into it mid-run.
const BASE = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS + 10 * 3_600_000;

// Each row's `expect` is derived from the rule quoted above, by hand:
//   listened = min(gap to next play, duration); skipped iff listened < 0.35 * duration.
const TIMELINE = [
  { id: "t0", off: 0, dur: 200_000, skip: 1 }, //     gap 30_000 < 70_000
  { id: "t1", off: 30_000, dur: 200_000, skip: 0 }, // gap 200_000 → min 200_000 ≥ 70_000
  { id: "t2", off: 230_000, dur: 100_000, skip: 0 }, // gap 100_000 ≥ 35_000
  { id: "t3", off: 330_000, dur: 100_000, skip: 0 }, // gap 35_000 == 35% exactly → NOT a skip
  { id: "t4", off: 365_000, dur: 100_000, skip: 1 }, // gap 34_999, one ms under the line
  { id: "t5", off: 399_999, dur: null, skip: 0 }, //    unknown duration → permissive
  { id: "t6", off: 500_000, dur: 240_000, skip: 0 }, // gap 3_600_000 capped at duration
  { id: "t7", off: 4_100_000, dur: 240_000, skip: 1 }, // gap 1_000 < 84_000
  { id: "t8", off: 4_101_000, dur: 240_000, skip: 0 }, // gap 240_000 == duration
  { id: "t9", off: 4_341_000, dur: 300_000, skip: null }, // newest → stays pending
] as const;

const PLAYS = TIMELINE.map((r) => play(r.id, iso(BASE + r.off), r.dur));
const EXPECTED_VERDICTS: Record<string, number | null> = Object.fromEntries(
  TIMELINE.map((r) => [`${r.id}@${iso(BASE + r.off)}`, r.skip]),
);
// Seven plays survive the skip filter (t0, t4, t7 are skips; a pending t9 counts).
const COUNTED = TIMELINE.filter((r) => r.skip !== 1).length;
// playsWithListened (db.ts:865-897): gaps over the FULL chain, then skips drop out.
//   t1 200_000 + t2 100_000 + t3 35_000 + t5 100_001 (10-min fallback, capped by gap)
//   + t6 240_000 + t8 240_000 + t9 300_000 (no successor → the whole duration)
const LISTENED_MS = 200_000 + 100_000 + 35_000 + 100_001 + 240_000 + 240_000 + 300_000;
// t0 is a skip, so the earliest play that survives the filter is t1 — `since` comes off the
// FILTERED list (db.ts:1074-1075).
const SINCE = iso(BASE + 30_000);

type Order = { name: string; batches: number[][] };
const singles = (idx: number[]): number[][] => idx.map((i) => [i]);
const ORDERS: Order[] = [
  { name: "one batch, chronological", batches: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]] },
  { name: "one batch, reverse-chronological", batches: [[9, 8, 7, 6, 5, 4, 3, 2, 1, 0]] },
  { name: "one play per call, chronological (tail appends)", batches: singles([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) },
  { name: "one play per call, reverse (every insert out-of-order)", batches: singles([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) },
  { name: "interleaved batches, stride 3", batches: [[0, 3, 6, 9], [1, 4, 7], [2, 5, 8]] },
  { name: "seeded shuffle, 3 uneven batches", batches: [[4, 9, 1], [7, 0, 5, 2], [8, 3, 6]] },
  { name: "seeded shuffle, singles", batches: singles([6, 2, 9, 0, 5, 8, 1, 7, 3, 4]) },
  { name: "gap-fill last: ends, then the middle", batches: [[0, 9], [4, 5], [1, 2, 3], [6, 7, 8]] },
];

async function feed(order: Order): Promise<void> {
  for (const batch of order.batches) await recordPlays(batch.map((i) => PLAYS[i]));
}

describe("recordPlays — arrival order must not change the timeline's verdicts", () => {
  beforeEach(resetStore);

  it.each(ORDERS)("$name → the documented per-play verdicts", async (order) => {
    await feed(order);
    expect(await verdicts()).toEqual(EXPECTED_VERDICTS);
  });

  it.each(ORDERS)("$name → the same all-time totals", async (order) => {
    await feed(order);
    const stats = await recomputeAllTimeStats();
    expect(stats.plays).toBe(COUNTED);
    expect(stats.uniqueTracks).toBe(COUNTED);
    expect(stats.durationMs).toBe(LISTENED_MS);
    expect(stats.since).toBe(SINCE);
  });

  it.each(ORDERS)("$name → the same day strip and the same all-time list", async (order) => {
    await feed(order);
    const daily = await getDailyStats(0, 400);
    expect(daily.map((d) => [d.day, d.plays, d.uniqueTracks, d.durationMs])).toEqual([
      [iso(BASE).slice(0, 10), COUNTED, COUNTED, LISTENED_MS],
    ]);
    const list = await getAllTimePlays(500);
    expect(list.reduce((n, t) => n + t.plays, 0)).toBe(COUNTED);
  });
});

describe("recordPlays — idempotency", () => {
  beforeEach(resetStore);

  it("re-recording the whole batch, and every prefix, changes nothing", async () => {
    await recordPlays(PLAYS);
    const before = await verdicts();
    const stats = await recomputeAllTimeStats();

    expect(await recordPlays(PLAYS)).toBe(0);
    for (let n = 1; n <= PLAYS.length; n++) {
      expect(await recordPlays(PLAYS.slice(0, n))).toBe(0);
    }
    // Same plays delivered as a reversed batch is still the same set.
    expect(await recordPlays([...PLAYS].reverse())).toBe(0);

    expect(await verdicts()).toEqual(before);
    expect(await recomputeAllTimeStats()).toEqual(stats);
  });

  it("returns the count of plays that were actually new, not of rows offered", async () => {
    expect(await recordPlays(PLAYS.slice(0, 4))).toBe(4);
    expect(await recordPlays(PLAYS.slice(2, 7))).toBe(3);
    expect(await recordPlays([])).toBe(0);
    // The same (track, played_at) offered twice inside ONE batch is one play.
    const dup = play("dup", iso(BASE + 9_000_000), 200_000);
    expect(await recordPlays([dup, { ...dup }])).toBe(1);
  });
});

describe("cross-reader invariants", () => {
  beforeEach(resetStore);

  it("every day card's play count equals its day view's rows (db.ts:768-784)", async () => {
    // Plays scattered over four local days, with null durations so nothing is ruled a skip
    // (the skip filter is exercised elsewhere; here the subject is bucketing).
    const rows = [];
    for (let d = 0; d < 4; d++) {
      for (const h of [1, 9, 23]) {
        rows.push(play(`d${d}h${h}`, iso(BASE - d * DAY_MS + (h - 10) * 3_600_000), null));
      }
    }
    await recordPlays(rows);
    for (const offset of [0, -240, 330]) {
      const daily = await getDailyStats(offset, 400);
      expect(daily.length).toBeGreaterThan(0);
      for (const card of daily) {
        const view = await getPlaysByDay(card.day, offset);
        expect({ day: card.day, plays: view.reduce((n, t) => n + t.plays, 0) }).toEqual({
          day: card.day,
          plays: card.plays,
        });
      }
      expect(daily.reduce((n, d) => n + d.plays, 0)).toBe(rows.length);
    }
  });

  it("the day strip's total equals the recomputed all-time play count", async () => {
    await recordPlays(PLAYS);
    const daily = await getDailyStats(0, 400);
    const stats = await recomputeAllTimeStats();
    expect(daily.reduce((n, d) => n + d.plays, 0)).toBe(stats.plays);
    expect(daily.reduce((n, d) => n + d.durationMs, 0)).toBe(stats.durationMs);
  });
});

describe("timezone bucketing", () => {
  beforeEach(resetStore);

  it("conserves the play count across every offset the clamp allows", async () => {
    await recordPlays(PLAYS);
    for (const offset of [-720, -300, 0, 330, 840]) {
      const daily = await getDailyStats(offset, 400);
      expect({ offset, total: daily.reduce((n, d) => n + d.plays, 0) }).toEqual({
        offset,
        total: COUNTED,
      });
      // A play may not be counted in two buckets, so unique days can only ever partition it.
      expect(new Set(daily.map((d) => d.day)).size).toBe(daily.length);
    }
  });

  it("a play at exactly local midnight lands in exactly one day, on both readers", async () => {
    const offset = -240; // New York, EDT
    const dayStart = Math.floor((Date.now() - 2 * DAY_MS) / DAY_MS) * DAY_MS; // 00:00 UTC
    const localMidnight = dayStart + 240 * 60_000; // 00:00 local == 04:00 UTC
    const day = iso(dayStart).slice(0, 10);
    const prevDay = iso(dayStart - DAY_MS).slice(0, 10);
    await recordPlays([
      play("before", iso(localMidnight - 1), null),
      play("at", iso(localMidnight), null),
      play("after", iso(localMidnight + 12 * 3_600_000), null),
    ]);

    const daily = await getDailyStats(offset, 400);
    const byDay = Object.fromEntries(daily.map((d) => [d.day, d.plays]));
    expect(byDay).toEqual({ [prevDay]: 1, [day]: 2 });

    const midnightDay = await getPlaysByDay(day, offset);
    expect(midnightDay.map((t) => t.id).sort()).toEqual(["after", "at"]);
    const earlier = await getPlaysByDay(prevDay, offset);
    expect(earlier.map((t) => t.id)).toEqual(["before"]);
  });
});
