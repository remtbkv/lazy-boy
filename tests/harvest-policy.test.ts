// Known answers for Phase 3's probe and harvest policy (docs/multi-user/PLAN.md §7.2-7.5): what a
// `/me/player` probe counts as a track change, when it writes, which trigger a harvest is tagged
// with, and when each user is next due. Beside tests/harvest-gate.test.ts, whose single-user rule
// this replaces at Phase 3's turn.
import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  COMPLETENESS_CHANGES,
  PROBE_EVERY_MS,
  TAIL_RETRY_MS,
  afterHarvest,
  backoffMs,
  decideHarvest,
  nextDue,
  observe,
  syncStateFor,
  uidPhase,
  type HarvestInput,
  type PlayerObservation,
  type ProbeState,
} from "@/lib/harvest-policy";

const S = 1_000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 16, 18, 0);

const playing = (trackId: string, progressMs: number): PlayerObservation => ({ trackId, isPlaying: true, progressMs });
const paused = (trackId: string, progressMs: number): PlayerObservation => ({ trackId, isPlaying: false, progressMs });
const NO_DEVICE: PlayerObservation = null;

function state(over: Partial<ProbeState> = {}): ProbeState {
  return { v: 1, track: "x", progressMs: 0, at: T0, stoppedAt: null, changes: 0, tail: false, retryAt: null, ...over };
}

describe("the probe: what counts as a track change, and when it writes", () => {
  it("the first probe records what it sees and counts nothing", () => {
    const r = observe(null, playing("x", 5 * S), T0);
    expect(r).toMatchObject({ write: true, change: false });
    expect(r.next).toEqual(state({ progressMs: 5 * S }));
    const idle = observe(null, NO_DEVICE, T0);
    expect(idle.next).toMatchObject({ track: null, stoppedAt: T0, changes: 0, tail: false });
  });

  it("the same track playing on, as far as the time allows, writes nothing", () => {
    const prev = state({ progressMs: 10 * S });
    const r = observe(prev, playing("x", 10 * S + 2 * MIN - 3 * S), T0 + 2 * MIN);
    expect(r).toEqual({ next: prev, write: false, change: false });
  });

  it("a different track id is a change", () => {
    const r = observe(state(), playing("y", 20 * S), T0 + 2 * MIN);
    expect(r.change).toBe(true);
    expect(r.write).toBe(true);
    expect(r.next).toMatchObject({ track: "y", progressMs: 20 * S, at: T0 + 2 * MIN, changes: 1, tail: false });
  });

  it("the same track with progress lower than the elapsed time allows is a repeat", () => {
    // 100 s in at T0; two minutes later a track that kept playing would be at 220 s.
    const prev = state({ progressMs: 100 * S });
    expect(observe(prev, playing("x", 40 * S), T0 + 2 * MIN)).toMatchObject({ change: true, write: true });
    // Ten seconds of slack: a clock or report lag is not a repeat.
    expect(observe(prev, playing("x", 211 * S), T0 + 2 * MIN)).toMatchObject({ change: false, write: false });
    expect(observe(prev, playing("x", 209 * S), T0 + 2 * MIN)).toMatchObject({ change: true });
  });

  it("the expected progress runs from the last write, not from the last probe", () => {
    // Nothing was written at T0+2m (the track played on), so at T0+4m the anchor is still T0.
    const prev = state({ progressMs: 10 * S });
    expect(observe(prev, playing("x", 10 * S + 4 * MIN), T0 + 4 * MIN)).toMatchObject({ change: false, write: false });
    expect(observe(prev, playing("x", 10 * S + 2 * MIN), T0 + 4 * MIN)).toMatchObject({ change: true });
  });

  it("playback stopping is a change and opens the session tail, whether paused or gone", () => {
    for (const obs of [paused("x", 50 * S), NO_DEVICE]) {
      const r = observe(state({ progressMs: 30 * S }), obs, T0 + 2 * MIN);
      expect(r).toMatchObject({ change: true, write: true });
      expect(r.next).toMatchObject({ stoppedAt: T0 + 2 * MIN, tail: true, changes: 1, track: "x" });
    }
  });

  it("a stopped player that stays stopped writes nothing, and a vanished device keeps the last track", () => {
    const stopped = state({ stoppedAt: T0, tail: false });
    expect(observe(stopped, NO_DEVICE, T0 + 2 * MIN)).toEqual({ next: stopped, write: false, change: false });
    expect(observe(stopped, paused("x", 0), T0 + 2 * MIN)).toEqual({ next: stopped, write: false, change: false });
  });

  it("resuming the same track writes the play state and is not a change", () => {
    const r = observe(state({ stoppedAt: T0, progressMs: 30 * S }), playing("x", 31 * S), T0 + 10 * MIN);
    expect(r).toMatchObject({ change: false, write: true });
    expect(r.next).toMatchObject({ stoppedAt: null, at: T0 + 10 * MIN, progressMs: 31 * S, changes: 0 });
  });

  it("a paused track's progress is the anchor: no time is added while it was stopped", () => {
    const prev = state({ stoppedAt: T0, progressMs: 30 * S });
    // Paused at 30 s, resumed and now at 25 s: a seek back or a repeat, counted.
    expect(observe(prev, playing("x", 25 * S - 11 * S), T0 + 10 * MIN)).toMatchObject({ change: true });
  });

  it("changes accumulate until a harvest resets them", () => {
    let p: ProbeState = state();
    for (const [i, id] of ["a", "b", "c"].entries()) p = observe(p, playing(id, 0), T0 + (i + 1) * 2 * MIN).next;
    expect(p.changes).toBe(3);
    expect(afterHarvest(p, "change", T0 + 7 * MIN)).toMatchObject({ changes: 0, tail: false, retryAt: null });
  });
});

describe("the harvest decision (§7.4) and its trigger tag", () => {
  const base = (over: Partial<HarvestInput> = {}): HarvestInput => ({
    now: T0 + 10 * MIN,
    probe: state(),
    probeOk: true,
    lastHarvestAt: T0,
    brake: "normal",
    backstopMs: HOUR,
    cooldownUntil: 0,
    openApp: false,
    ...over,
  });

  it("no change, no tail, inside the backstop: no harvest", () => {
    expect(decideHarvest(base())).toBeNull();
  });

  it("a track change harvests at once while the brake is off", () => {
    expect(decideHarvest(base({ probe: state({ changes: 1 }), lastHarvestAt: T0 + 9 * MIN }))).toBe("change");
  });

  it("past a user's share, changes wait for a 15-minute batch; past the app's budget, 30", () => {
    const p = state({ changes: 3 });
    expect(decideHarvest(base({ probe: p, brake: "share", lastHarvestAt: T0 + 10 * MIN - 14 * MIN }))).toBeNull();
    expect(decideHarvest(base({ probe: p, brake: "share", lastHarvestAt: T0 + 10 * MIN - 15 * MIN }))).toBe("change");
    expect(decideHarvest(base({ probe: p, brake: "all", lastHarvestAt: T0 + 10 * MIN - 29 * MIN }))).toBeNull();
    expect(decideHarvest(base({ probe: p, brake: "all", lastHarvestAt: T0 + 10 * MIN - 30 * MIN }))).toBe("change");
  });

  it("completeness at 25 changes, whatever the brake says", () => {
    const now = T0 + 10 * MIN;
    for (const brake of ["normal", "share", "all"] as const) {
      expect(decideHarvest(base({ brake, probe: state({ changes: COMPLETENESS_CHANGES }), lastHarvestAt: now }))).toBe(
        "completeness",
      );
    }
    expect(decideHarvest(base({ brake: "all", probe: state({ changes: COMPLETENESS_CHANGES - 1 }), lastHarvestAt: now }))).toBeNull();
    expect(COMPLETENESS_CHANGES).toBe(25);
  });

  it("the session tail fires in every mode, and its retry about 5 minutes later, once", () => {
    const now = T0 + 10 * MIN;
    for (const brake of ["normal", "share", "all"] as const) {
      expect(decideHarvest(base({ brake, probe: state({ tail: true, changes: 1, stoppedAt: now }), lastHarvestAt: now - MIN }))).toBe("tail");
    }
    const afterTail = afterHarvest(state({ tail: true, changes: 1, stoppedAt: now }), "tail", now);
    expect(afterTail).toMatchObject({ tail: false, changes: 0, retryAt: now + TAIL_RETRY_MS });
    expect(TAIL_RETRY_MS).toBe(5 * MIN);
    // Due 30 s early, like every due time, so a tick a little early does not push it 2 minutes.
    expect(decideHarvest(base({ brake: "all", now: now + 4 * MIN, probe: afterTail, lastHarvestAt: now }))).toBeNull();
    expect(decideHarvest(base({ brake: "all", now: now + 4.5 * MIN, probe: afterTail, lastHarvestAt: now }))).toBe("tail-retry");
    const afterRetry = afterHarvest(afterTail, "tail-retry", now + 5 * MIN);
    expect(afterRetry.retryAt).toBeNull();
    expect(decideHarvest(base({ now: now + 7 * MIN, probe: afterRetry, lastHarvestAt: now + 5 * MIN }))).toBeNull();
  });

  it("any later harvest covers the tail's retry", () => {
    const p = state({ retryAt: T0 + 20 * MIN, changes: 1 });
    expect(afterHarvest(p, "change", T0 + 12 * MIN).retryAt).toBeNull();
  });

  it("the backstop: hourly in Phase 3, 2 hours from Phase 4a, in every mode", () => {
    const now = T0 + 10 * HOUR;
    expect(decideHarvest(base({ now, lastHarvestAt: now - 59 * MIN }))).toBeNull();
    expect(decideHarvest(base({ now, lastHarvestAt: now - HOUR }))).toBe("backstop");
    expect(decideHarvest(base({ now, lastHarvestAt: now - HOUR, backstopMs: 2 * HOUR }))).toBeNull();
    expect(decideHarvest(base({ now, brake: "all", lastHarvestAt: now - 2 * HOUR, backstopMs: 2 * HOUR }))).toBe("backstop");
    // Never harvested: the backstop is overdue.
    expect(decideHarvest(base({ lastHarvestAt: null }))).toBe("backstop");
  });

  it("opening the app catches up a change the brake held back, at least 60 s after the last harvest", () => {
    const now = T0 + 10 * MIN;
    const p = state({ changes: 2 });
    expect(decideHarvest(base({ now, probe: p, brake: "all", lastHarvestAt: now - 5 * MIN, openApp: true }))).toBe("open-app");
    expect(decideHarvest(base({ now, probe: p, brake: "all", lastHarvestAt: now - 59 * S, openApp: true }))).toBeNull();
    // Nothing seen since the last harvest: opening the app spends nothing.
    expect(decideHarvest(base({ now, probe: state(), brake: "all", lastHarvestAt: now - 5 * MIN, openApp: true }))).toBeNull();
    // With the brake off a change harvests anyway, tagged as the change it is.
    expect(decideHarvest(base({ now, probe: p, lastHarvestAt: now - 5 * MIN, openApp: true }))).toBe("change");
  });

  it("the recently-played cooldown holds every trigger", () => {
    const now = T0 + 10 * MIN;
    expect(decideHarvest(base({ now, cooldownUntil: now + 1, probe: state({ tail: true, changes: 30 }), lastHarvestAt: null }))).toBeNull();
    expect(decideHarvest(base({ now, cooldownUntil: now, probe: state({ tail: true }) }))).toBe("tail");
  });

  it("a probe that could not run: users active in the last 3 hours are harvested every 30 minutes", () => {
    const now = T0 + 10 * HOUR;
    const recent = state({ stoppedAt: now - 2 * HOUR });
    expect(decideHarvest(base({ now, probeOk: false, probe: recent, lastHarvestAt: now - 29 * MIN }))).toBeNull();
    expect(decideHarvest(base({ now, probeOk: false, probe: recent, lastHarvestAt: now - 30 * MIN }))).toBe("backstop");
    expect(decideHarvest(base({ now, probeOk: false, probe: state({ stoppedAt: null }), lastHarvestAt: now - 30 * MIN }))).toBe("backstop");
    const quiet = state({ stoppedAt: now - 3 * HOUR - S });
    expect(decideHarvest(base({ now, probeOk: false, probe: quiet, lastHarvestAt: now - 30 * MIN }))).toBeNull();
  });
});

describe("a listening session, probe by probe", () => {
  // The step's own order: observe, decide, and on a harvest that landed, afterHarvest.
  function run(seq: { at: number; obs: PlayerObservation }[], backstopMs = HOUR) {
    let p: ProbeState | null = null;
    let last: number | null = T0 - 30 * MIN;
    const tags: (string | null)[] = [];
    let writes = 0;
    for (const { at, obs } of seq) {
      const o = observe(p, obs, at);
      p = o.next;
      let w = o.write;
      const t = decideHarvest({ now: at, probe: p, probeOk: true, lastHarvestAt: last, brake: "normal", backstopMs, cooldownUntil: 0, openApp: false });
      tags.push(t);
      if (t) {
        const after = afterHarvest(p, t, at);
        if (JSON.stringify(after) !== JSON.stringify(p)) w = true;
        p = after;
        last = at;
      }
      if (w) writes++;
    }
    return { tags, writes };
  }

  it("five tracks then silence: one harvest per change, the tail, its retry, then the hourly backstop", () => {
    const seq = [
      { at: T0, obs: playing("a", 0) },
      { at: T0 + 2 * MIN, obs: playing("a", 2 * MIN) },
      { at: T0 + 4 * MIN, obs: playing("b", 30 * S) },
      { at: T0 + 6 * MIN, obs: playing("c", 10 * S) },
      { at: T0 + 8 * MIN, obs: playing("d", 50 * S) },
      { at: T0 + 10 * MIN, obs: playing("e", 70 * S) },
      { at: T0 + 12 * MIN, obs: NO_DEVICE },
      { at: T0 + 14 * MIN, obs: NO_DEVICE },
      { at: T0 + 16 * MIN, obs: NO_DEVICE },
      { at: T0 + 18 * MIN, obs: NO_DEVICE },
      { at: T0 + 60 * MIN, obs: NO_DEVICE },
      { at: T0 + 80 * MIN, obs: NO_DEVICE },
    ];
    const { tags, writes } = run(seq);
    expect(tags).toEqual([
      null, // the first probe: harvested 30 minutes before, nothing seen yet
      null,
      "change",
      "change",
      "change",
      "change",
      "tail",
      null,
      null, // 4 minutes after the tail: not yet
      "tail-retry", // 6 minutes after: the first probe at or past ~5
      null,
      "backstop", // an hour after the retry
    ]);
    // Writes: the first probe, four changes (each also reset by its harvest, one write each), the
    // stop, the retry's clear. The quiet probes and the backstop wrote nothing.
    expect(writes).toBe(1 + 4 + 1 + 1);
  });

  it("a repeat of the same song counts once per repeat", () => {
    const seq = [
      { at: T0, obs: playing("a", 0) },
      { at: T0 + 2 * MIN, obs: playing("a", 2 * MIN) },
      { at: T0 + 4 * MIN, obs: playing("a", 30 * S) },
      { at: T0 + 6 * MIN, obs: playing("a", 2.5 * MIN) },
    ];
    expect(run(seq).tags).toEqual([null, null, "change", null]);
  });
});

describe("cadence (§7.2, decision 28 as ruled): every 2 minutes whatever N, offset by uid", () => {
  const A = "aaaaaaaaaaaa";
  const B = "bbbbbbbbbbbb";

  it("the uid's phase is stable and spreads users", () => {
    expect(uidPhase(A)).toBe(uidPhase(A));
    expect(uidPhase(A)).not.toBe(uidPhase(B));
    for (const u of [A, B, "234567abcdef"]) {
      expect(uidPhase(u)).toBeGreaterThanOrEqual(0);
      expect(uidPhase(u)).toBeLessThan(PROBE_EVERY_MS);
    }
  });

  // A tick at T claims a user when their due time is at most T + 30 s.
  function claimedAt(ticks: number[], uid: string, start: number): number[] {
    let due = start;
    const out: number[] = [];
    for (const t of ticks) {
      if (due <= t + 30 * S) {
        out.push(t);
        due = nextDue(uid, due, t);
      }
    }
    return out;
  }
  const gaps = (xs: number[]) => xs.slice(1).map((x, i) => (x - xs[i]) / MIN);

  it("with both pingers (a tick a minute) each user is probed every 2 minutes", () => {
    const ticks = Array.from({ length: 30 }, (_, i) => T0 + i * MIN + 3 * S);
    for (const u of [A, B]) {
      const got = claimedAt(ticks, u, T0);
      expect(gaps(got).slice(1).every((g) => g === 2)).toBe(true);
    }
  });

  it("with either pinger alone (a tick every 2 minutes) still every 2 minutes", () => {
    for (const offset of [0, MIN]) {
      const ticks = Array.from({ length: 15 }, (_, i) => T0 + offset + i * 2 * MIN + 5 * S);
      for (const u of [A, B]) {
        expect(gaps(claimedAt(ticks, u, T0)).every((g) => g === 2)).toBe(true);
      }
    }
  });

  it("a late tick (up to 30 s) does not stretch two minutes to four", () => {
    const ticks = [T0, T0 + 2 * MIN + 25 * S, T0 + 4 * MIN, T0 + 6 * MIN - 20 * S, T0 + 8 * MIN];
    expect(claimedAt(ticks, A, T0)).toHaveLength(5);
  });

  it("after an outage the user rejoins on their own phase, two to three minutes out", () => {
    const t = T0 + 5 * HOUR + 7 * S;
    const next = nextDue(A, T0, t);
    expect(next - t).toBeGreaterThan(90 * S);
    expect(next - t).toBeLessThanOrEqual(210 * S);
    expect((((next - uidPhase(A)) % PROBE_EVERY_MS) + PROBE_EVERY_MS) % PROBE_EVERY_MS).toBe(0);
  });

  it("backoff: 2, 4, 8 … 60 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((f) => backoffMs(f) / MIN)).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
    expect(BACKOFF_MAX_MS).toBe(60 * MIN);
  });

  it("the queue's state: active within 30 minutes of a play, else idle", () => {
    const now = T0 + HOUR;
    expect(syncStateFor(state({ stoppedAt: null }), now)).toBe("active");
    expect(syncStateFor(state({ stoppedAt: now - 29 * MIN }), now)).toBe("active");
    expect(syncStateFor(state({ stoppedAt: now - 31 * MIN }), now)).toBe("idle");
    expect(syncStateFor(null, now)).toBe("idle");
  });
});
