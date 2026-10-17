// Simulation: the plays pipeline end-to-end against a real (throwaway, local) SQLite
// store — inserts, skip verdicts, out-of-order re-adjudication, backfill exclusion,
// counters. Every case here pins a finding from the 2026-08-19 audit.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkPlayedAtConvention,
  getAllTimeStats,
  getDailyStats,
  getPlaysByDay,
  recordPlays,
  getSpotifyCooldownUntil,
  setSpotifyCooldownUntil,
  acquireLock,
  releaseLock,
  recomputeAllTimeStats,
  type PlayRecord,
} from "@/lib/db";
import { resetStore, verdicts } from "./adversarial/helpers";

// All timestamps on one fixed local day, UTC offset 0 for determinism.
const DAY = "2026-08-10";
const at = (hhmmss: string, ms = "000") => `${DAY}T${hhmmss}.${ms}Z`;

let n = 0;
function play(
  playedAt: string,
  over: Partial<PlayRecord> = {},
): PlayRecord {
  n += 1;
  return {
    trackId: over.trackId ?? `t${n}`,
    name: over.name ?? `Song ${over.trackId ?? n}`,
    artist: over.artist ?? "Artist",
    uri: `spotify:track:${over.trackId ?? `t${n}`}`,
    album: null,
    albumImage: null,
    durationMs: over.durationMs ?? 180_000, // 3:00 → skip bar at 63s
    playedAt,
    contextType: over.contextType ?? null,
    contextUri: over.contextUri ?? null,
    ...over,
  };
}

describe("plays pipeline (simulated store)", () => {
  beforeAll(async () => {
    // Warm the store (runs migrations once).
    await recordPlays([]);
  });

  it("in-order inserts: each play is ruled from its predecessor as it lands", async () => {
    // played_at is the END of a play (C1). 10:00 → first play, no predecessor → NOT skipped.
    // 10:03 (3-min song) ran 180s since 10:00 → NOT skipped.
    // 10:03:30 (3-min song) ran 30s < 63s → SKIPPED.
    const a = play(at("10:00:00"), { trackId: "a" });
    const b = play(at("10:03:00"), { trackId: "b" });
    const c = play(at("10:03:30"), { trackId: "c" });
    expect(await recordPlays([a])).toBe(1);
    expect(await recordPlays([a, b])).toBe(1); // dedupe: a already stored
    expect(await recordPlays([a, b, c])).toBe(1);

    const rows = await getPlaysByDay(DAY, 0);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).not.toContain("c"); // skipped → hidden
  });

  it("duplicate (trackId, playedAt) never double-counts", async () => {
    const d = play(at("11:00:00"), { trackId: "d" });
    expect(await recordPlays([d])).toBe(1);
    expect(await recordPlays([d])).toBe(0);
  });

  it("out-of-order gap-fill re-opens ONLY the true successor's verdict", async () => {
    // Existing: e1 12:00, e3 12:10 (e3 verdicted not-skipped: ran 600s capped at 180s).
    const e1 = play(at("12:00:00"), { trackId: "e1" });
    const e3 = play(at("12:10:00"), { trackId: "e3" });
    await recordPlays([e1, e3]);
    // Gap-fill: e2 ends at 12:09:40 → e3 now ran 20s < 63s → e3 must flip to SKIPPED.
    const e2 = play(at("12:09:40"), { trackId: "e2" });
    await recordPlays([e1, e2, e3]);
    const rows = await getPlaysByDay(DAY, 0);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("e3"); // re-adjudicated to skipped
    expect(ids).toContain("e1");
    // e2's own verdict: ran ≈ 580s since e1 → not skipped.
    expect(ids).toContain("e2");
  });

  it("backfill rows are excluded from counters but keep real plays intact", async () => {
    const bf = play("2026-05-30T00:00:00.000Z", {
      trackId: "bf1",
      contextType: "backfill",
    });
    await recordPlays([bf]);
    const daily = await getDailyStats(0, 3650);
    const bfDay = daily.find((d) => d.day === "2026-05-30");
    expect(bfDay).toBeUndefined(); // never a day card
    await recomputeAllTimeStats();
    const all = await getAllTimeStats();
    // All-time counts only the real plays inserted above (a,b,d,e1,e2 — c,e3 skipped).
    expect(all.plays).toBe(5);
    expect(all.since >= at("10:00:00")).toBe(true); // never the backfill sentinel
  });

  it("daily stats agree with the day view on count and exclusions", async () => {
    // getDailyStats windows from Date.now(); pin only Date (the lock test needs real timers).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    let daily: Awaited<ReturnType<typeof getDailyStats>>;
    try {
      daily = await getDailyStats(0, 30);
    } finally {
      vi.useRealTimers();
    }
    const day = daily.find((d) => d.day === DAY);
    const rows = await getPlaysByDay(DAY, 0);
    const rowPlays = rows.reduce((s, r) => s + r.plays, 0);
    expect(day?.plays).toBe(rowPlays);
  });

  it("cooldown persist is monotonic (a shorter later ban cannot shorten a longer one)", async () => {
    const far = Date.now() + 30 * 60 * 1000;
    const near = Date.now() + 60 * 1000;
    await setSpotifyCooldownUntil(far);
    await setSpotifyCooldownUntil(near);
    expect(await getSpotifyCooldownUntil()).toBe(Math.floor(far));
    // A LONGER later ban does extend.
    const farther = far + 60_000;
    await setSpotifyCooldownUntil(farther);
    expect(await getSpotifyCooldownUntil()).toBe(Math.floor(farther));
  });

  it("locks: nonce owners, expiry takeover, release only frees your own", async () => {
    const a = await acquireLock("simtest", 200);
    expect(a).not.toBeNull();
    expect(await acquireLock("simtest", 200)).toBeNull(); // held
    await new Promise((r) => setTimeout(r, 250));
    const b = await acquireLock("simtest", 60_000); // expired → takeover
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    await releaseLock("simtest", a as string); // stale owner: must NOT free b's lock
    expect(await acquireLock("simtest", 60_000)).toBeNull();
    await releaseLock("simtest", b as string);
    expect(await acquireLock("simtest", 60_000)).not.toBeNull();
  });
});

// C1 (burn lazyboy-review, 2026-10-03): Spotify's played_at is the moment a play ENDED, so a
// play's run time is the gap from the PREVIOUS play's end, capped at its own duration. Known
// answers from the review's spec; each case runs on an emptied store.
describe("skip verdicts and listened time come from the previous play (C1)", () => {
  beforeEach(resetStore);
  const T = Date.parse("2026-07-01T10:00:00.000Z");

  it("plays ending at T, T+200s (200s song), T+230s (180s song): 2 is a listen, 3 a skip", async () => {
    await recordPlays([
      play(new Date(T).toISOString(), { trackId: "k1", durationMs: 200_000 }),
      play(new Date(T + 200_000).toISOString(), { trackId: "k2", durationMs: 200_000 }),
      play(new Date(T + 230_000).toISOString(), { trackId: "k3", durationMs: 180_000 }),
    ]);
    expect(await verdicts()).toEqual({
      [`k1@${new Date(T).toISOString()}`]: 0, // first play: no predecessor → ran in full
      [`k2@${new Date(T + 200_000).toISOString()}`]: 0, // ran 200 of 200 s
      [`k3@${new Date(T + 230_000).toISOString()}`]: 1, // ran 30 of 180 s < 35%
    });
    const all = await recomputeAllTimeStats();
    expect(all.plays).toBe(2);
    expect(all.durationMs).toBe(200_000 + 200_000);
  });

  it("listened time is the run from the previous play, capped at the song", async () => {
    await recordPlays([
      play(new Date(T).toISOString(), { trackId: "m1", durationMs: 200_000 }),
      play(new Date(T + 200_000).toISOString(), { trackId: "m2", durationMs: 200_000 }),
      play(new Date(T + 300_000).toISOString(), { trackId: "m3", durationMs: 180_000 }),
      // An hour of idle before it: capped at its own 240 s.
      play(new Date(T + 4_000_000).toISOString(), { trackId: "m4", durationMs: 240_000 }),
    ]);
    const all = await recomputeAllTimeStats();
    expect(all.plays).toBe(4);
    expect(all.durationMs).toBe(200_000 + 200_000 + 100_000 + 240_000);
  });

  it("the newest play is ruled on arrival, not left pending", async () => {
    await recordPlays([play(new Date(T).toISOString(), { trackId: "n1", durationMs: 200_000 })]);
    await recordPlays([play(new Date(T + 10_000).toISOString(), { trackId: "n2", durationMs: 200_000 })]);
    expect(await verdicts()).toEqual({
      [`n1@${new Date(T).toISOString()}`]: 0,
      [`n2@${new Date(T + 10_000).toISOString()}`]: 1,
    });
  });

  it("an older play inserted between two verdicted plays re-rules its SUCCESSOR only", async () => {
    const a = play(new Date(T).toISOString(), { trackId: "o1", durationMs: 200_000 });
    const c = play(new Date(T + 300_000).toISOString(), { trackId: "o3", durationMs: 200_000 });
    await recordPlays([a, c]);
    expect(Object.values(await verdicts())).toEqual([0, 0]);
    // o2 ends 10 s before o3 does: o3 now ran 10 s → skipped. o1 has no reason to move.
    const b = play(new Date(T + 290_000).toISOString(), { trackId: "o2", durationMs: 200_000 });
    await recordPlays([b]);
    expect(await verdicts()).toEqual({
      [`o1@${new Date(T).toISOString()}`]: 0,
      [`o2@${new Date(T + 290_000).toISOString()}`]: 0, // ran 290 s capped at 200
      [`o3@${new Date(T + 300_000).toISOString()}`]: 1,
    });
  });

  it("the daily convention check reads the last week and flags start stamps", async () => {
    const start = Date.now() - 2 * 86_400_000;
    const durs = [200_000, 180_000];
    // Each gap equals the EARLIER play's duration: start stamps, the convention flipped.
    const flipped = Array.from({ length: 25 }, (_, i) =>
      play(new Date(start + i * 190_000 + (i % 2) * 10_000).toISOString(), {
        trackId: `cv${i}`,
        durationMs: durs[i % 2],
      }),
    );
    await recordPlays(flipped);
    const r = await checkPlayedAtConvention();
    expect(r).toMatchObject({ pairs: 24, earlier: 24, later: 0, inverted: true });
  });

  it("the day strip measures its first play from the play before the window", async () => {
    // getDailyStats(0, 1) reads from now − 3 days. p ends 5 min before that cutoff, q 5 min
    // after: q ran 10 min of its 20, so the strip must count 600 s, not q's full 1,200 s.
    const cutoff = Date.now() - 3 * 86_400_000;
    await recordPlays([
      play(new Date(cutoff - 300_000).toISOString(), { trackId: "p", durationMs: 1_200_000 }),
      play(new Date(cutoff + 300_000).toISOString(), { trackId: "q", durationMs: 1_200_000 }),
    ]);
    const daily = await getDailyStats(0, 1);
    expect(daily.reduce((s, d) => s + d.plays, 0)).toBe(1);
    expect(daily.reduce((s, d) => s + d.durationMs, 0)).toBe(600_000);
  });
});
