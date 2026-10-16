// The hourly health check's verdict (docs/multi-user/PLAN.md §7.10). Pure, so each condition
// has a known answer (tests/isolation/health.test.ts); /api/cron/health gathers the inputs.
//
// It answers red with a one-word reason and nothing about anyone's listening. An input that
// cannot be measured is null and listed as unchecked, never read as healthy or as red:
//   - isolation events: Phase 1 records them as telemetry rows (isolation.ts); the route reads
//     those newer than the last one a check reported, so each turns it red once; telemetry
//     down = unchecked;
//   - the daily chores' stamp (`daily_at`, written when /api/cron/daily finishes); never
//     stamped yet = unchecked;
//   - Turso's month-to-date pace, as the daily chores' usage check last measured it; no
//     verdict in the last 26 hours (unconfigured, or the platform API down) = unchecked;
//   - the budget (CAPACITY §6, src/lib/budget/): red while the app-wide mode is economy or
//     freeze, which it is whenever any dimension is; never recorded yet = unchecked;
//   - the CPU meter: red when it has written nothing for six hours, or never (every cron tick
//     is metered, so a healthy meter writes every few minutes); telemetry down = unchecked.
// The owner's capture uses capture-health.ts's rule (no token row, or no harvest in two
// hours). PLAN.md says 30 minutes since his last successful tick; before Phase 3 there is no
// per-tick stamp, and `last_sync` moves only on a harvest, which the harvest gate holds back
// for up to an hour, so 30 minutes would turn red on a quiet evening.
import type { CaptureHealth } from "@/lib/capture-health";
import type { Mode } from "@/lib/budget/modes";

export type HealthInputs = {
  /** Isolation events recorded since the last check window began; null = not measurable. */
  isolationEvents: number | null;
  ownerCapture: CaptureHealth | null;
  /** Age of the daily chores' completion stamp; null = not measurable. */
  dailyAgeMs: number | null;
  /** Turso's month-to-date reads ahead of the month's pace; null = not measurable. */
  quotaAhead: boolean | null;
  /** The stored app-wide budget mode; null = never recorded or not readable. */
  budgetMode: Mode | null;
  /** Since the meter's last write (Infinity = never); null = not measurable. */
  meterAgeMs: number | null;
};

export type HealthReason = "isolation" | "owner-capture" | "daily" | "quota-pace" | "budget" | "meter";
export type HealthVerdict = { ok: boolean; reasons: HealthReason[]; unchecked: string[] };

export const DAILY_STALE_MS = 26 * 3_600_000;
export const METER_QUIET_MS = 6 * 3_600_000;

export function healthVerdict(i: HealthInputs): HealthVerdict {
  const reasons: HealthReason[] = [];
  const unchecked: string[] = [];
  if (i.isolationEvents === null) unchecked.push("isolation");
  else if (i.isolationEvents > 0) reasons.push("isolation");
  if (i.ownerCapture === null) unchecked.push("owner-capture");
  else if (!i.ownerCapture.ok) reasons.push("owner-capture");
  if (i.dailyAgeMs === null) unchecked.push("daily");
  else if (i.dailyAgeMs > DAILY_STALE_MS) reasons.push("daily");
  if (i.quotaAhead === null) unchecked.push("quota-pace");
  else if (i.quotaAhead) reasons.push("quota-pace");
  if (i.budgetMode === null) unchecked.push("budget");
  else if (i.budgetMode !== "normal") reasons.push("budget");
  if (i.meterAgeMs === null) unchecked.push("meter");
  else if (i.meterAgeMs > METER_QUIET_MS) reasons.push("meter");
  return { ok: reasons.length === 0, reasons, unchecked };
}
