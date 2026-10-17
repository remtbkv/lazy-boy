// The daily chores (QUEUE.md C2; docs/STORE_MIGRATION.md §6.7; multi-user PLAN.md §7.11), in one
// place for their two callers: `/api/cron/daily` (Vercel's cron, 09:00 UTC, vercel.json) and the
// tick (`TickDeps.dailyChores`, under `lock:daily`), which runs them when `app_meta.daily_at` is
// over 26 hours old, so either pinger covers a missed cron. They used to sit in /api/cron/sync
// behind an `x-vercel-cron` header Vercel never sends, so none of them ran from Aug 10 to the
// store split. 09:00, not sync's 07:00: the Zenbook reboots around 07:00 UTC, and the prunes and
// the ledger rows go to the telemetry store on it.
//
// Each chore is isolated: one failing never stops the rest, and every chore's outcome comes back.
// It notifies nobody (R6): the usage check's breach verdict is recorded in the outcome and the
// ledger, not raised. The per-user chores run for the admin's store, which the caller passes;
// Phase 4a's (daily-4a.ts: deletion retries, day 4 of `revoked`, the 14-day invite expiry, the
// sweeps, re-enabling the cron-job.org jobs; no dormant move and no twelve-month deletion, RULINGS
// Oct 15) run after them. The caller stamps `app_meta.daily_at` when the run finishes, which the
// hourly health check (§7.10) and the tick read.
import "server-only";
import { runPhase4aChores } from "@/lib/daily-4a";
import { pruneApiLog, pruneClientMetrics, type UserStore } from "@/lib/db";
import { runUsageCheck } from "@/lib/usage-check";
import { runBudgetChore } from "@/lib/budget/daily";

type Chore = [name: string, run: (store: UserStore) => Promise<unknown>];

const CHORES: Chore[] = [
  // Daily heal for the throttled all-time recompute: a listening session's last plays can
  // land inside the 10-min gate and stay uncounted until the next session.
  ["recomputeAllTimeStats", (s) => s.recomputeAllTimeStats()],
  // …and the heal must reach Home: the card renders the copy embedded in home_payload, which
  // only rebuilds when a play lands (audit 2026-08-19, T2.2).
  ["rebuildHomePayload", (s) => s.rebuildHomePayload()],
  // Retention, on the telemetry store. The write-path counter resets with every serverless
  // instance and may never fire (audit 2026-08-19, T2.17).
  ["pruneApiLog", pruneApiLog],
  ["pruneClientMetrics", pruneClientMetrics],
  // Spotify has flipped what played_at marks before; if it does again, every skip verdict
  // inverts silently. This logs it (skip-rule.ts playedAtConvention).
  ["checkPlayedAtConvention", (s) => s.checkPlayedAtConvention()],
  // Turso's real month-to-date usage and yesterday's reconciliation, into the ledger /usage
  // shows. Its 500 means "breach" to an external alarm; here it is only an outcome, plus the
  // pace verdict the health check turns red on.
  [
    "runUsageCheck",
    async (s) => {
      const { status, body } = await runUsageCheck();
      if (Array.isArray(body.breached)) {
        const pace = { at: Date.now(), ahead: body.breached.length > 0 };
        await s.setHealthMark("quota_pace", JSON.stringify(pace));
      }
      return status === 200 ? "ok" : `status ${status}: ${JSON.stringify(body).slice(0, 300)}`;
    },
  ],
  // The budget (CAPACITY §6): the meter's and Turso's month-to-date, projected; the record
  // /usage shows and the app-wide mode the hot paths and the health check read.
  ["runBudgetChore", () => runBudgetChore()],
];

/** Every daily chore once, each isolated, Phase 4a's after the owner's; their outcomes by name. */
export async function runDailyChores(store: UserStore): Promise<Record<string, string>> {
  const chores: Record<string, string> = {};
  for (const [name, run] of CHORES) {
    const t0 = Date.now();
    try {
      const out = await run(store);
      chores[name] = typeof out === "string" ? out : `ok ${Date.now() - t0}ms`;
    } catch (e) {
      console.error(`[cron/daily] ${name} failed`, e);
      chores[name] = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ...chores, ...(await runPhase4aChores()) };
}
