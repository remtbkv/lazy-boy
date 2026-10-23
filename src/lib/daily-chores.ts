import "server-only";
import { pruneApiLog, pruneClientMetrics, type UserStore } from "@/lib/db";
import { runUsageCheck } from "@/lib/usage-check";
import { runBudgetChore } from "@/lib/budget/daily";

// The daily chores (QUEUE.md C2; docs/STORE_MIGRATION.md §6.7; multi-user PLAN §7.11), run by
// /api/cron/daily (Vercel's cron, 09:00 UTC) and by a cron tick that finds `app_meta.daily_at`
// over 26 hours old (sync/tick.ts, under `lock:daily`), so either pinger covers a missed cron.
// Each chore is isolated: one failing never stops the rest. The caller stamps `daily_at` when
// the run finishes.
//
// They run for the admin (OWNER_UID) alone: Phases 1-3 serve nobody else (SIGNUPS=owner), and
// the per-user loop over every user's database comes with the first friend (Phase 4a).
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

/** Every chore once, each isolated; their outcomes by name. */
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
  return chores;
}
