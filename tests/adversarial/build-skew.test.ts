// ADVERSARIAL — src/lib/build-skew.ts
// Expectations from the file's three-brakes documentation (lines 1-32) and the
// two-sources asymmetry note (lines 7-20).

import { describe, expect, it } from "vitest";
import {
  evaluateSkew,
  NO_SKEW,
  MISMATCH_GRACE_MS,
  RELOAD_THROTTLE_MS,
  INTERACTION_IDLE_MS,
  type SkewInput,
  type SkewStreak,
} from "@/lib/build-skew";

const T = 1_700_000_000_000;

const input = (over: Partial<SkewInput> = {}): SkewInput => ({
  clientBuild: "old",
  serverBuild: "new",
  source: "authoritative",
  now: T,
  streak: NO_SKEW,
  lastReloadAt: null,
  visible: false,
  lastInteractionAt: null,
  ...over,
});

const running = (since: number, authMismatch = true): SkewStreak => ({ since, authMismatch });

describe("evaluateSkew — silence", () => {
  it("a missing id on either side is evidence of nothing", () => {
    // "No signal ... is evidence of nothing. Carry the streak through untouched — silence
    //  must neither reload nor absolve." (build-skew.ts:74-77)
    const streak = running(T - MISMATCH_GRACE_MS * 2);
    for (const over of [
      { clientBuild: undefined },
      { serverBuild: undefined },
      { clientBuild: "" },
      { serverBuild: "" },
      { clientBuild: undefined, serverBuild: undefined },
    ]) {
      const d = evaluateSkew(input({ ...over, streak }));
      expect(d.reload).toBe(false);
      expect(d.streak).toBe(streak);
    }
  });
});

describe("evaluateSkew — the debounce brake", () => {
  it("a fresh mismatch starts the streak and does not reload", () => {
    const d = evaluateSkew(input());
    expect(d.reload).toBe(false);
    expect(d.streak.since).toBe(T);
    expect(d.streak.authMismatch).toBe(true);
  });

  it("one tick short of the grace window does not reload", () => {
    const d = evaluateSkew(
      input({ now: T + MISMATCH_GRACE_MS - 1, streak: running(T) }),
    );
    expect(d.reload).toBe(false);
    expect(d.streak.since).toBe(T);
  });

  it("exactly MISMATCH_GRACE_MS of continuous mismatch reloads", () => {
    // "Only a mismatch held CONTINUOUSLY for MISMATCH_GRACE_MS reloads" (build-skew.ts:26-28)
    expect(evaluateSkew(input({ now: T + MISMATCH_GRACE_MS, streak: running(T) })).reload).toBe(
      true,
    );
  });

  it("a flapping edge never accumulates a streak", () => {
    // "a deploy mid-propagation can serve mixed old/new responses ... so a flapping edge
    //  can't [reload]" (build-skew.ts:26-28)
    let streak = NO_SKEW;
    let reloads = 0;
    for (let i = 0; i < 60; i++) {
      const now = T + i * 30_000;
      const agree = i % 2 === 0;
      const d = evaluateSkew(
        input({
          now,
          streak,
          source: "authoritative",
          serverBuild: agree ? "old" : "new",
        }),
      );
      streak = d.streak;
      if (d.reload) reloads++;
    }
    expect(reloads).toBe(0);
  });

  it("an authoritative match clears the streak outright", () => {
    // "an authoritative match clears the streak" (build-skew.ts:17-18)
    const d = evaluateSkew(
      input({ serverBuild: "old", source: "authoritative", streak: running(T - 10 * 60_000) }),
    );
    expect(d.streak).toEqual(NO_SKEW);
    expect(d.reload).toBe(false);
  });
});

describe("evaluateSkew — the poll/authoritative asymmetry", () => {
  it("a poll match clears a streak no probe has contradicted", () => {
    // "a poll match clears only a streak no unpinned probe has contradicted"
    const d = evaluateSkew(
      input({ serverBuild: "old", source: "poll", streak: running(T - 60_000, false) }),
    );
    expect(d.streak).toEqual(NO_SKEW);
  });

  it("a poll match does NOT clear a streak an authoritative probe contradicted", () => {
    // "Authoritative mismatch alongside poll match is not a contradiction to average away —
    //  it is the signature of a pinned tab, and it counts as mismatch." (build-skew.ts:19-20)
    const d = evaluateSkew(
      input({
        serverBuild: "old",
        source: "poll",
        now: T + 60_000,
        streak: running(T, true),
      }),
    );
    expect(d.streak.since).toBe(T);
    expect(d.streak.authMismatch).toBe(true);
    expect(d.reload).toBe(false);
  });

  it("a pinned tab (auth mismatch, poll agrees forever) still reloads at the grace mark", () => {
    let streak = evaluateSkew(input({ source: "authoritative", now: T })).streak;
    let reloaded = false;
    for (let i = 1; i <= 40; i++) {
      const now = T + i * 6_000; // the 6s now-playing poll, always agreeing
      const d = evaluateSkew(input({ now, streak, source: "poll", serverBuild: "old" }));
      streak = d.streak;
      if (d.reload) {
        reloaded = true;
        expect(now - T).toBeGreaterThanOrEqual(MISMATCH_GRACE_MS);
        break;
      }
    }
    expect(reloaded).toBe(true);
  });

  it("a poll mismatch alone never sets authMismatch", () => {
    const d = evaluateSkew(input({ source: "poll" }));
    expect(d.streak.authMismatch).toBe(false);
    expect(d.streak.since).toBe(T);
  });

  it("an authoritative mismatch latches authMismatch for the rest of the streak", () => {
    const a = evaluateSkew(input({ source: "poll", now: T }));
    const b = evaluateSkew(input({ source: "authoritative", now: T + 1_000, streak: a.streak }));
    const c = evaluateSkew(input({ source: "poll", now: T + 2_000, streak: b.streak }));
    expect(c.streak.authMismatch).toBe(true);
    expect(c.streak.since).toBe(T);
  });
});

describe("evaluateSkew — the throttle brake", () => {
  const past = input({ now: T + MISMATCH_GRACE_MS, streak: running(T) });

  it("suppresses a second reload inside RELOAD_THROTTLE_MS", () => {
    const d = evaluateSkew({ ...past, lastReloadAt: past.now - RELOAD_THROTTLE_MS + 1 });
    expect(d.reload).toBe(false);
    expect(d.streak.since).toBe(T); // the streak keeps running
  });

  it("allows a reload at exactly RELOAD_THROTTLE_MS", () => {
    expect(evaluateSkew({ ...past, lastReloadAt: past.now - RELOAD_THROTTLE_MS }).reload).toBe(true);
  });

  it("never reloads faster than one per throttle window over a long broken-beacon run", () => {
    // "if the beacon itself is ever broken ... one reload per RELOAD_THROTTLE_MS bounds the
    //  damage to a slow blink, not a reload loop" (build-skew.ts:28-30)
    let streak = NO_SKEW;
    let lastReloadAt: number | null = null;
    const at: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const now = T + i * 6_000;
      const d = evaluateSkew(input({ now, streak, lastReloadAt, source: "authoritative" }));
      streak = d.streak;
      if (d.reload) {
        at.push(now);
        lastReloadAt = now;
        streak = NO_SKEW; // a reload restarts the tab
      }
    }
    expect(at.length).toBeGreaterThan(0);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(RELOAD_THROTTLE_MS);
    }
  });

  it("a lastReloadAt stamped in the FUTURE does not suppress the reload", () => {
    // The throttle is specified as "one reload per RELOAD_THROTTLE_MS". lastReloadAt is read
    // from localStorage (build-skew.ts:58-60), so it survives a system-clock correction: a
    // stamp ahead of `now` means no reload has happened in the last throttle window, yet the
    // `now - lastReloadAt < RELOAD_THROTTLE_MS` test reads it as one that just happened and
    // blocks reloads for the whole skew — unbounded, not one window.
    expect(evaluateSkew({ ...past, lastReloadAt: past.now + 86_400_000 }).reload).toBe(true);
  });
});

describe("evaluateSkew — the deferral brake", () => {
  const past = input({ now: T + MISMATCH_GRACE_MS, streak: running(T) });

  it("defers while the tab is visible and recently touched, keeping the streak", () => {
    // "While the tab is visible and was touched within INTERACTION_IDLE_MS the reload waits;
    //  the streak keeps running" (build-skew.ts:30-32)
    const d = evaluateSkew({
      ...past,
      visible: true,
      lastInteractionAt: past.now - INTERACTION_IDLE_MS + 1,
    });
    expect(d.reload).toBe(false);
    expect(d.streak.since).toBe(T);
  });

  it("fires at the next idle moment", () => {
    const d = evaluateSkew({
      ...past,
      visible: true,
      lastInteractionAt: past.now - INTERACTION_IDLE_MS,
    });
    expect(d.reload).toBe(true);
  });

  it("fires immediately when hidden, however recent the interaction", () => {
    const d = evaluateSkew({ ...past, visible: false, lastInteractionAt: past.now });
    expect(d.reload).toBe(true);
  });

  it("an untouched visible tab is not busy", () => {
    expect(evaluateSkew({ ...past, visible: true, lastInteractionAt: null }).reload).toBe(true);
  });
});

describe("evaluateSkew — clock hostility", () => {
  it("a backwards clock does not reload early", () => {
    const d = evaluateSkew(input({ now: T - 60_000, streak: running(T) }));
    expect(d.reload).toBe(false);
    expect(d.streak.since).toBe(T);
  });

  it("a backwards clock does not silently extend the streak start", () => {
    // `since = streak.since ?? now` only fills a null; a running streak keeps its origin.
    const d = evaluateSkew(input({ now: T - 60_000, streak: running(T, false) }));
    expect(d.streak.since).toBe(T);
  });

  it("recovers and reloads once the clock passes the grace mark again", () => {
    let streak = running(T);
    expect(evaluateSkew(input({ now: T - 60_000, streak })).reload).toBe(false);
    streak = evaluateSkew(input({ now: T - 60_000, streak })).streak;
    expect(evaluateSkew(input({ now: T + MISMATCH_GRACE_MS, streak })).reload).toBe(true);
  });
});
