import { cronAuthorized } from "@/lib/cron-auth";
import { forUser, pruneApiLog, pruneClientMetrics, type UserStore } from "@/lib/db";
import { phase1Owner } from "@/lib/identity";
import { runUsageCheck } from "@/lib/usage-check";
import { runBudgetChore } from "@/lib/budget/daily";

// The daily chores (QUEUE.md C2; docs/STORE_MIGRATION.md §6.7). Vercel's cron calls this at
// 09:00 UTC (vercel.json) with `Authorization: Bearer $CRON_SECRET`. They used to sit in
// /api/cron/sync behind an `x-vercel-cron` header Vercel never sends, so none of them ran from
// Aug 10 to the store split. 09:00, not sync's 07:00: the Zenbook reboots around 07:00 UTC,
// and the prunes and the ledger rows go to the telemetry store on it.
//
// Each chore is isolated: one failing never stops the rest, and the route answers 200 with
// every chore's outcome. It notifies nobody (R6): the usage check's breach verdict is recorded
// in the response and the ledger, not raised. The cron-job.org watchdog that rode the old
// block (ensureCronJobEnabled) is not run here: the job it re-enables holds a stale secret,
// so re-enabling it only produces cron-job.org's daily "disabled automatically" e-mail
// (burn lazyboy-review Z2; deleting or re-keying the job is Rem's call). Its code,
// src/lib/cronjob.ts, left with that block; git history has it.
//
// Phase 1 has one user, so the per-user chores run for the owner (OWNER_UID); Phase 3's
// daily loop runs them per user (multi-user PLAN §7.11). When every chore has run, the route
// stamps `daily_at` and the usage check's pace verdict, which the hourly health check reads
// (§7.10).
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

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const owner = phase1Owner();
  if (!owner) return Response.json({ ok: false, error: "no owner" }, { status: 503 });
  const store = forUser(owner);
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
  // Every chore ran (each isolated, so this is "the run finished", not "all succeeded").
  await store.setHealthMark("daily_at", String(Date.now())).catch((e) => {
    console.error("[cron/daily] daily_at stamp failed", e);
  });
  return Response.json({ ok: true, chores });
}
