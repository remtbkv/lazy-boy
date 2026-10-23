import { acquireAppLock, getAppMeta, releaseAppLock, setAppMeta } from "@/lib/app-db";
import { cronAuthorized } from "@/lib/cron-auth";
import { runDailyChores } from "@/lib/daily-chores";
import { adminStore } from "@/lib/identity-read";
import { DAILY_LOCK_MS } from "@/lib/sync/tick";

// The daily chores (QUEUE.md C2; docs/STORE_MIGRATION.md §6.7). Vercel's cron calls this at
// 09:00 UTC (vercel.json) with `Authorization: Bearer $CRON_SECRET`. They used to sit in
// /api/cron/sync behind an `x-vercel-cron` header Vercel never sends, so none of them ran from
// Aug 10 to the store split. 09:00, not sync's 07:00: the Zenbook reboots around 07:00 UTC,
// and the prunes and the ledger rows go to the telemetry store on it.
//
// The chores themselves are src/lib/daily-chores.ts, which a cron tick also runs when this
// route's stamp is over 26 hours old (multi-user PLAN §7.11). Each chore is isolated: one
// failing never stops the rest, and the route answers 200 with every chore's outcome. It
// notifies nobody (R6): the usage check's breach verdict is recorded in the response and the
// ledger, not raised. The cron-job.org watchdog that rode the old block (ensureCronJobEnabled)
// is not run here: the job it re-enables holds a stale secret, so re-enabling it only produces
// cron-job.org's daily "disabled automatically" e-mail (burn lazyboy-review Z2; deleting or
// re-keying the job is Rem's call). Its code, src/lib/cronjob.ts, left with that block; git
// history has it.
//
// When every chore has run, the route stamps `app_meta.daily_at`, which the tick and the hourly
// health check read (§7.10, §7.11).
//
// Once a UTC day: a second delivery of the cron, or the cron after a tick already ran the chores
// that day (daily_at gone stale before 09:00), runs nothing; and the run holds the tick's
// `lock:daily`, so the two never run at once (the two-user rehearsal's daily cycle ran them twice
// both ways, docs/multi-user/REHEARSAL.md check 9).
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  let owner: string | null;
  try {
    const last = Number(await getAppMeta("daily_at")) || 0;
    if (last && utcDay(last) === utcDay(Date.now())) return Response.json({ ok: true, skipped: "ran today" });
    owner = await acquireAppLock("lock:daily", DAILY_LOCK_MS);
  } catch (e) {
    console.error("[cron/daily] app database unread", e);
    return Response.json({ ok: false, error: "store" }, { status: 503 });
  }
  if (!owner) return Response.json({ ok: true, skipped: "running" });
  try {
    // The admin's database, as his `users` row names it (multi-user Phase 2).
    const store = await adminStore().catch((e) => (console.error("[cron/daily] admin row unread", e), undefined));
    if (!store) return Response.json({ ok: false, error: store === null ? "no owner" : "store" }, { status: 503 });
    const chores = await runDailyChores(store);
    // Every chore ran (each isolated, so this is "the run finished", not "all succeeded").
    await setAppMeta("daily_at", String(Date.now())).catch((e) => {
      console.error("[cron/daily] daily_at stamp failed", e);
    });
    return Response.json({ ok: true, chores });
  } finally {
    await releaseAppLock("lock:daily", owner).catch(() => {});
  }
}
