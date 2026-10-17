// The hourly health check (docs/multi-user/PLAN.md §7.10): a cron-job.org job with failure
// e-mail calls this; a 500 is the e-mail. The reply carries reasons and the names of checks
// not yet measurable, never anything about anyone's listening (cron-job.org keeps bodies).
import { getAppMeta, markEventsAlarmed, unreportedEvents } from "@/lib/app-db";
import { getBudgetMode, readBudgetDay, readMeter } from "@/lib/db";
import { worstMode } from "@/lib/budget/budget";
import { isMode } from "@/lib/budget/modes";
import { cronCaller } from "@/lib/cron-auth";
import { DAILY_STALE_MS, healthVerdict } from "@/lib/health";
import { adminStore } from "@/lib/identity-read";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronCaller(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  let ownerCapture = null;
  let marks;
  let dailyMark: string | null;
  try {
    const store = await adminStore();
    if (!store) return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
    [ownerCapture, marks, dailyMark] = await Promise.all([
      store.getCaptureHealth(),
      store.getHealthMarks(),
      getAppMeta("daily_at"),
    ]);
  } catch {
    // The store did not answer: that is itself a reason to wake Rem.
    return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
  }

  // Isolation events in lazyboy-app's `events` that no check has reported yet (§6.5): each
  // e-mails once, then is marked. The app database not answering makes the count
  // unmeasurable, not zero.
  const events = await unreportedEvents().catch(() => null);
  if (events && events.count > 0 && events.newest !== null) {
    await markEventsAlarmed(events.newest).catch(() => {});
  }

  // The daily chores stamp `app_meta.daily_at` when they finish, whether the daily route or a
  // tick ran them; never stamped yet = not measurable.
  const dailyAt = Number(dailyMark) || 0;
  // Turso's pace, as the daily chores last measured it: older than the chores' own window
  // is no verdict at all.
  let quotaAhead: boolean | null = null;
  try {
    const pace = marks.quota_pace ? (JSON.parse(marks.quota_pace) as { at: number; ahead: boolean }) : null;
    if (pace && Date.now() - pace.at <= DAILY_STALE_MS) quotaAhead = pace.ahead === true;
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
    isolationEvents: events ? events.count : null,
    ownerCapture,
    dailyAgeMs: dailyAt ? Date.now() - dailyAt : null,
    quotaAhead,
    budgetMode,
    meterAgeMs: meter ? (meter.lastAt === null ? Number.POSITIVE_INFINITY : Date.now() - meter.lastAt) : null,
  });
  return Response.json(v, { status: v.ok ? 200 : 500 });
}
