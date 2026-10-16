// The hourly health check (docs/multi-user/PLAN.md §7.10): a cron-job.org job with failure
// e-mail calls this; a 500 is the e-mail. The reply carries reasons and the names of checks
// not yet measurable, never anything about anyone's listening (cron-job.org keeps bodies).
import { forUser, isolationEventsAfter } from "@/lib/db";
import { cronCaller } from "@/lib/cron-auth";
import { DAILY_STALE_MS, healthVerdict } from "@/lib/health";
import { phase1Owner } from "@/lib/identity";

export const dynamic = "force-dynamic";

// An isolation event older than this and never reported is past saving as news; the bound
// keeps the hourly read to two days of telemetry rows on its ts index.
const ISOLATION_LOOKBACK_MS = 48 * 3_600_000;

export async function GET(req: Request) {
  if (!cronCaller(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const owner = phase1Owner();
  if (!owner) return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
  const store = forUser(owner);
  let ownerCapture = null;
  let marks;
  try {
    [ownerCapture, marks] = await Promise.all([store.getCaptureHealth(), store.getHealthMarks()]);
  } catch {
    // The store did not answer: that is itself a reason to wake Rem.
    return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
  }

  // Isolation events since the last one a check reported (each e-mails once, §7.10). The
  // telemetry store being down makes the count unmeasurable, not zero.
  const floor = new Date(Date.now() - ISOLATION_LOOKBACK_MS).toISOString();
  const seen = marks.isolation_seen && marks.isolation_seen > floor ? marks.isolation_seen : floor;
  const events = await isolationEventsAfter(seen).catch(() => null);
  if (events && events.count > 0 && events.newest) {
    await store.setHealthMark("isolation_seen", events.newest).catch(() => {});
  }

  // The daily chores stamp `daily_at` when they finish; never stamped yet = not measurable.
  const dailyAt = Number(marks.daily_at) || 0;
  // Turso's pace, as the daily chores last measured it: older than the chores' own window
  // is no verdict at all.
  let quotaAhead: boolean | null = null;
  try {
    const pace = marks.quota_pace ? (JSON.parse(marks.quota_pace) as { at: number; ahead: boolean }) : null;
    if (pace && Date.now() - pace.at <= DAILY_STALE_MS) quotaAhead = pace.ahead === true;
  } catch {
    /* unreadable: unchecked */
  }

  const v = healthVerdict({
    isolationEvents: events ? events.count : null,
    ownerCapture,
    dailyAgeMs: dailyAt ? Date.now() - dailyAt : null,
    quotaAhead,
  });
  return Response.json(v, { status: v.ok ? 200 : 500 });
}
