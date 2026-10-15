// The hourly health check's verdict (docs/multi-user/PLAN.md §7.10). Pure, so each condition
// has a known answer (tests/isolation/health.test.ts); /api/cron/health gathers the inputs.
//
// It answers red with a one-word reason and nothing about anyone's listening. An input that
// cannot be measured yet is null and listed as unchecked, never read as healthy or as red:
//   - isolation events: Phase 1 records them as telemetry rows (isolation.ts), and the read
//     belongs in db.ts, which queued lanes edit; it is wired in Phase 1's turn;
//   - the daily chores' stamp: /api/cron/daily does not exist until STORE_MIGRATION lane 1901;
//   - Turso's month-to-date pace: the store is self-hosted until the cutover (lane 1903).
// The owner's capture uses capture-health.ts's rule (no token row, or no harvest in two
// hours). PLAN.md says 30 minutes since his last successful tick; before Phase 3 there is no
// per-tick stamp, and `last_sync` moves only on a harvest, which the harvest gate holds back
// for up to an hour, so 30 minutes would turn red on a quiet evening.
import type { CaptureHealth } from "@/lib/capture-health";

export type HealthInputs = {
  /** Isolation events recorded since the last check window began; null = not measurable. */
  isolationEvents: number | null;
  ownerCapture: CaptureHealth | null;
  /** Age of the daily chores' completion stamp; null = not measurable. */
  dailyAgeMs: number | null;
  /** Turso's month-to-date reads ahead of the month's pace; null = not measurable. */
  quotaAhead: boolean | null;
};

export type HealthReason = "isolation" | "owner-capture" | "daily" | "quota-pace";
export type HealthVerdict = { ok: boolean; reasons: HealthReason[]; unchecked: string[] };

export const DAILY_STALE_MS = 26 * 3_600_000;

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
  return { ok: reasons.length === 0, reasons, unchecked };
}
