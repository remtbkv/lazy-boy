// The hourly health check (docs/multi-user/PLAN.md §7.10): a cron-job.org job with failure
// e-mail calls this; a 500 is the e-mail. The reply carries reasons and the names of checks
// not yet measurable, never anything about anyone's listening (cron-job.org keeps bodies).
// From Phase 4a it also reads the app database (events not yet reported, each e-mailed once, and
// the users stuck in a state someone must act on) and records every red verdict it answers, with
// its time and reasons, in `app_meta` (`health_red:<ms>`), which is how lanes 28 and 29 prove the
// planted probe's alarm went out.
import { readHealth, recordHealthRed } from "@/lib/app-db";
import { readCapture } from "@/lib/capture-read";
import { getBudgetMode, readBudgetDay, readMeter } from "@/lib/db";
import { worstMode } from "@/lib/budget/budget";
import { isMode } from "@/lib/budget/modes";
import { cronCaller } from "@/lib/cron-auth";
import { DAILY_STALE_MS, healthVerdict, isolationCount } from "@/lib/health";
import { adminStore } from "@/lib/identity-read";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronCaller(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const now = Date.now();
  let ownerCapture = null;
  let marks;
  let app: Awaited<ReturnType<typeof readHealth>>;
  try {
    // The admin's database, as his users row names it (multi-user Phase 2); none is a store failure.
    const store = await adminStore();
    if (!store) {
      await recordHealthRed(now, ["store"]).catch(() => {});
      return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
    }
    [ownerCapture, marks, app] = await Promise.all([
      readCapture(store.uid).then((c) => c.health),
      store.getHealthMarks(),
      readHealth(now),
    ]);
  } catch {
    // A store did not answer: that is itself a reason to wake Rem.
    await recordHealthRed(now, ["store"]).catch(() => {});
    return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
  }

  // Isolation events are the app database's `events` rows no check has reported (§6.5), read and
  // marked by readHealth in one batch, so each e-mails once; isolation.ts awaits each row where it
  // is raised, so telemetry being down loses none. The daily chores stamp `app_meta.daily_at` when
  // they finish, whether the daily route or a tick ran them; never stamped yet = not measurable.
  const dailyAt = app.dailyAt ?? 0;
  // Turso's pace, as the daily chores last measured it: older than the chores' own window
  // is no verdict at all.
  let quotaAhead: boolean | null = null;
  try {
    const pace = marks.quota_pace ? (JSON.parse(marks.quota_pace) as { at: number; ahead: boolean }) : null;
    if (pace && now - pace.at <= DAILY_STALE_MS) quotaAhead = pace.ahead === true;
  } catch {
    /* unreadable: unchecked */
  }

  // The budget (lib/budget/): the stored mode, uncached, and the daily record's modes, the worst
  // of them (the chores write the record before the mode, so a failed mode write leaves only the
  // record saying economy); the meter's last write, any day.
  const [storedMode, record, meter] = await Promise.all([
    getBudgetMode(0).catch(() => null),
    readBudgetDay().catch(() => []),
    readMeter(new Date().toISOString().slice(0, 10)).catch(() => null),
  ]);
  const modes = [storedMode, ...record.map((r) => r.mode)].filter(isMode);
  const budgetMode = modes.length ? worstMode(modes) : null;

  const v = healthVerdict({
    isolationEvents: isolationCount(app.app),
    ownerCapture,
    dailyAgeMs: dailyAt ? now - dailyAt : null,
    quotaAhead,
    budgetMode,
    meterAgeMs: meter ? (meter.lastAt === null ? Number.POSITIVE_INFINITY : now - meter.lastAt) : null,
    app: app.app,
  });
  if (!v.ok) await recordHealthRed(now, v.reasons).catch((e) => console.error(`[health] red verdict not recorded: ${String(e)}`));
  return Response.json(v, { status: v.ok ? 200 : 500 });
}
