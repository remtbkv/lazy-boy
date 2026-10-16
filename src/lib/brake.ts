// The fair-share brake (docs/multi-user/PLAN.md §7.5; decision 28 as ruled Oct 15 1:17 PM: two
// minutes for everyone, the brake only as the safety valve). Pure; known answers in
// tests/brake.test.ts.
//
// Every recently-played and `/me` call increments the caller's `sync_state.rp_calls` for the quota
// day, awaited before the call, so a lost write cannot undercount (a re-sent one overcounts, the
// safe side). A user whose count reaches their share of the app's daily budget moves to one
// harvest per 15 minutes for the rest of the quota day; once the app's total reaches the budget,
// everyone moves to one per 30. Completeness, the session tail and its retry, the backstop and
// opening the app fire in every mode (harvest-policy.ts orders them ahead of the batch).
//
// It counted from Phase 3 and is switched on with the first friend (Phase 4a): BRAKE_ON.

/** On from Phase 4a (§7.5: N = 2 is the first week the bucket is shared). */
export const BRAKE_ON = true;

/** 450 a day (60% of the lowest observed ban, 01c §5.1), less the hourly recorder's 24. */
export const APP_DAILY_BUDGET = 426;

// The observed reset, 14:51 UTC (10:51 AM EDT, Aug 17), the anchor db.ts's
// getRecentlyPlayedQuotaWindows already buckets by.
const QUOTA_ANCHOR_MS = Date.UTC(2026, 0, 1, 14, 51);
const DAY_MS = 24 * 3_600_000;

/** The quota day a call at `now` counts toward, named by the UTC date it began on. */
export function quotaDay(now: number): string {
  const idx = Math.floor((now - QUOTA_ANCHOR_MS) / DAY_MS);
  return new Date(QUOTA_ANCHOR_MS + idx * DAY_MS).toISOString().slice(0, 10);
}

/** When the quota day that `now` falls in ends: the observed reset a QUOTA_EXCEEDED waits for. */
export function nextQuotaReset(now: number): number {
  return QUOTA_ANCHOR_MS + (Math.floor((now - QUOTA_ANCHOR_MS) / DAY_MS) + 1) * DAY_MS;
}

/** One user's share: the budget over the users the claim can lease. */
export function shareOf(users: number): number {
  return APP_DAILY_BUDGET / users;
}

export type BrakeMode = "normal" | "share" | "all";

export function brakeMode(i: { mine: number; total: number; users: number; on: boolean }): BrakeMode {
  if (!i.on || i.users < 1) return "normal";
  if (i.total >= APP_DAILY_BUDGET) return "all";
  if (i.mine >= shareOf(i.users)) return "share";
  return "normal";
}
