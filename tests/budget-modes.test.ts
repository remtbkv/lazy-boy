// Economy and freeze on the app-wide paths (docs/multi-user/CAPACITY.md §6's table): each
// mode's interval as the now-playing poller, SyncOnLoad and Home's open-tab refresh read it, the
// all-time gate, and the stored mode as the hot paths see it through their 10-minute cache.
// The route halves (now-playing's floor, /api/sync's interval) are in budget-routes.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@libsql/client";
import { appDatabaseUrl, getAppMeta } from "@/lib/app-db";
import { getBudgetMode, setBudgetMode } from "@/lib/db";
import { ALLTIME_GATE_MS, LIBRARY_RESCAN_MS, NOW_PLAYING_MIN_POLL_MS, SYNC_INTERVAL_MS, type Mode } from "@/lib/budget/modes";
import { currentMode } from "@/lib/budget/mode";
import { INITIAL_POLL_STATE, PollLoop, STEADY_MS, planNextPoll, type PollOutcome } from "@/lib/now-playing-poll";
import { SyncLoop, ambientGapMs, noteSyncReply, syncIntervalMs } from "@/lib/budget/sync-interval";
import { play, rawClient, resetStore } from "./adversarial/helpers";
import { ownerStore } from "./owner-store";

const MIN = 60_000;
const MODES: Mode[] = ["normal", "economy", "freeze"];

afterEach(() => {
  vi.useRealTimers();
});

describe("the policy table", () => {
  it("is CAPACITY §6's app-wide column", () => {
    expect(NOW_PLAYING_MIN_POLL_MS).toEqual({ normal: 0, economy: 30_000, freeze: 60_000 });
    expect(SYNC_INTERVAL_MS).toEqual({ normal: 2 * MIN, economy: 5 * MIN, freeze: 5 * MIN });
    expect(LIBRARY_RESCAN_MS).toEqual({ normal: 30 * MIN, economy: 120 * MIN, freeze: null });
    expect(ALLTIME_GATE_MS).toEqual({ normal: 10 * MIN, economy: 30 * MIN, freeze: 30 * MIN });
  });
});

// The mode is the app's, so it lives in the app database's app_meta (beside the cooldowns and
// the tick's stamps), never in a user's database.
async function appMeta(sql: string): Promise<void> {
  await getAppMeta("schema_version"); // the first open creates the app database
  const c = createClient({ url: appDatabaseUrl(), intMode: "number" });
  try {
    await c.execute(sql);
  } finally {
    c.close();
  }
}

describe("the stored mode and its cache", () => {
  beforeEach(async () => {
    await resetStore();
    await appMeta("DELETE FROM app_meta WHERE key = 'budget_mode'");
    await setBudgetMode("normal"); // resets this process's memo
    await appMeta("DELETE FROM app_meta WHERE key = 'budget_mode'");
  });

  it("never written reads as none (the hot paths take it as normal)", async () => {
    expect(await getBudgetMode(0)).toBeNull();
    expect(await currentMode()).toBe("normal");
  });

  it("a write is seen at once in this process; another instance's write within 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-16T10:00:00Z"));
    await setBudgetMode("economy");
    expect(await currentMode()).toBe("economy");
    // Another instance (the daily chores) moves it: this one sees it within 10 minutes.
    await appMeta("UPDATE app_meta SET value = 'freeze' WHERE key = 'budget_mode'");
    expect(await currentMode()).toBe("economy");
    vi.setSystemTime(Date.parse("2026-10-16T10:09:59Z"));
    expect(await currentMode()).toBe("economy");
    vi.setSystemTime(Date.parse("2026-10-16T10:10:00Z"));
    expect(await currentMode()).toBe("freeze");
    // The health check reads it uncached.
    await appMeta("UPDATE app_meta SET value = 'normal' WHERE key = 'budget_mode'");
    expect(await getBudgetMode(0)).toBe("normal");
  });

  it("a value that is not a mode reads as none", async () => {
    await appMeta("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('budget_mode', 'panic')");
    expect(await getBudgetMode(0)).toBeNull();
  });

  it("is the app's: in app_meta, untouched by the admin's database, read with OWNER_UID unset", async () => {
    await setBudgetMode("economy");
    const user = await rawClient();
    expect((await user.execute("SELECT value FROM meta WHERE key = 'budget_mode'")).rows).toEqual([]);
    const owner = process.env.OWNER_UID;
    delete process.env.OWNER_UID;
    try {
      expect(await getBudgetMode(0)).toBe("economy");
      await setBudgetMode("freeze");
      expect(await getAppMeta("budget_mode")).toBe("freeze");
    } finally {
      process.env.OWNER_UID = owner;
    }
  });
});

describe("the now-playing poller honours the server's floor", () => {
  const playing = { track: { id: "t1" }, isPlaying: true, progressMs: 10_000, durationMs: 200_000 };
  const ok = (minPollMs?: number): PollOutcome => ({ kind: "ok", playing, minPollMs });

  it("each mode's floor, read from the reply", () => {
    for (const mode of MODES) {
      const floor = NOW_PLAYING_MIN_POLL_MS[mode];
      expect(planNextPoll(INITIAL_POLL_STATE, ok(floor), true).delay).toBe(Math.max(STEADY_MS, floor));
    }
  });

  it("the floor holds for the track-end poll, a burst, an error and a skip until a reply lifts it", () => {
    const nearEnd = { ...playing, progressMs: 199_000 };
    const s1 = planNextPoll(INITIAL_POLL_STATE, { kind: "ok", playing: nearEnd, minPollMs: 30_000 }, true);
    expect(s1.delay).toBe(30_000);
    expect(planNextPoll(s1.state, { kind: "error" }, true).delay).toBe(30_000);
    expect(planNextPoll(s1.state, { kind: "skipped", retryInMs: 100 }, true).delay).toBe(30_000);
    // A reply without the field (an older deployment) keeps the last floor; normal's 0 lifts it.
    expect(planNextPoll(s1.state, { kind: "ok", playing }, true).delay).toBe(30_000);
    expect(planNextPoll(s1.state, ok(0), true).delay).toBe(STEADY_MS);
  });

  it("the loop's next request waits out the floor", async () => {
    vi.useFakeTimers();
    let floor = 30_000;
    const at: number[] = [];
    const t0 = Date.now();
    const loop = new PollLoop(async () => {
      at.push(Date.now() - t0);
      return ok(floor);
    }, () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(at).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toEqual([0, 30_000]);
    floor = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(at).toEqual([0, 30_000, 60_000]);
    await vi.advanceTimersByTimeAsync(STEADY_MS);
    expect(at).toEqual([0, 30_000, 60_000, 60_000 + STEADY_MS]);
    loop.stop();
  });
});

describe("SyncOnLoad's loop and Home's open-tab refresh read /api/sync's interval", () => {
  beforeEach(() => {
    noteSyncReply({ intervalMs: SYNC_INTERVAL_MS.normal });
  });

  function run(mode: Mode) {
    const at: number[] = [];
    const t0 = Date.now();
    const loop = new SyncLoop(
      async () => {
        at.push(Date.now() - t0);
        return { ok: true, intervalMs: SYNC_INTERVAL_MS[mode] };
      },
      () => true,
    );
    return { at, loop };
  }

  it("normal: on load, every 2 minutes after the last sync, and on every return to the tab", async () => {
    vi.useFakeTimers();
    const { at, loop } = run("normal");
    loop.start();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(at).toEqual([0, 2 * MIN]);
    await vi.advanceTimersByTimeAsync(10_000);
    loop.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toEqual([0, 2 * MIN, 2 * MIN + 10_000]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(at).toEqual([0, 2 * MIN, 2 * MIN + 10_000, 4 * MIN + 10_000]);
    loop.stop();
    expect(syncIntervalMs()).toBe(2 * MIN);
    expect(ambientGapMs(45_000)).toBe(45_000);
  });

  for (const mode of ["economy", "freeze"] as const) {
    it(`${mode}: every 5 minutes, and a return to the tab inside that waits`, async () => {
      vi.useFakeTimers();
      const { at, loop } = run(mode);
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(syncIntervalMs()).toBe(5 * MIN);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      loop.focus();
      await vi.advanceTimersByTimeAsync(0);
      expect(at).toEqual([0]);
      await vi.advanceTimersByTimeAsync(3 * MIN);
      expect(at).toEqual([0, 5 * MIN]);
      loop.stop();
      // Home's open-tab refresh: its timer and its focus throttle follow the same interval.
      expect(ambientGapMs(45_000)).toBe(5 * MIN - 30_000);
    });
  }

  it("a hidden tab does not sync; a failed reply keeps the last interval", async () => {
    vi.useFakeTimers();
    let visible = false;
    const at: number[] = [];
    const loop = new SyncLoop(async () => {
      at.push(Date.now());
      return null;
    }, () => visible);
    loop.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(at).toEqual([]);
    visible = true;
    noteSyncReply({ intervalMs: 5 * MIN });
    loop.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(1);
    expect(syncIntervalMs()).toBe(5 * MIN);
    loop.stop();
  });
});

// The cron tick's library rescan follows the mode in Phase 3's tick: tests/isolation/t4-tick.test.ts
// (economy's 2-hour floor, freeze's none) and tick-route.test.ts (the stored mode through the
// real route).

describe("the all-time recompute's gate follows the mode", () => {
  beforeEach(async () => {
    await resetStore();
  });

  async function landedAfter(minutes: number, mode: Mode): Promise<boolean> {
    await setBudgetMode(mode);
    const c = await rawClient();
    const stamp = String(Date.now() - minutes * MIN);
    await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('alltime_at', ?)", args: [stamp] });
    await ownerStore().recordPlays([play(`t${minutes}${mode}`, new Date(Date.now() - 5 * MIN).toISOString(), 180_000)]);
    const v = (await c.execute("SELECT value FROM meta WHERE key = 'alltime_at'")).rows[0]?.value;
    return String(v) !== stamp;
  }

  it("normal: 15 minutes since the last recompute runs it", async () => {
    expect(await landedAfter(15, "normal")).toBe(true);
  });
  it("economy and freeze: 15 minutes waits, 31 runs it", async () => {
    expect(await landedAfter(15, "economy")).toBe(false);
    expect(await landedAfter(31, "economy")).toBe(true);
    expect(await landedAfter(15, "freeze")).toBe(false);
    expect(await landedAfter(31, "freeze")).toBe(true);
  });
});
