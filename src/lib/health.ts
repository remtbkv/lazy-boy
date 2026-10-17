// The hourly health check's verdict (docs/multi-user/PLAN.md §7.10). Pure, so each condition
// has a known answer (tests/isolation/health.test.ts); /api/cron/health gathers the inputs.
//
// It answers red with a one-word reason and nothing about anyone's listening. An input that
// cannot be measured is null and listed as unchecked, never read as healthy or as red:
//   - isolation events: rows in the app database's `events` (isolation.ts) that no check has
//     reported; the route marks them `alarmed`, so each turns it red once; the app database
//     not answering = unchecked;
//   - the daily chores' stamp (`daily_at`, written when /api/cron/daily finishes); never
//     stamped yet = unchecked;
//   - Turso's month-to-date pace, as the daily chores' usage check last measured it; no
//     verdict in the last 26 hours (unconfigured, or the platform API down) = unchecked;
//   - the budget (CAPACITY §6, src/lib/budget/): red while the stored app-wide mode or any
//     dimension in the latest daily record is economy or freeze (the two part when the mode's
//     write fails after the record's); neither recorded yet = unchecked;
//   - the CPU meter: red when it has written nothing for six hours, or never (every cron tick
//     is metered, so a healthy meter writes every few minutes); telemetry down = unchecked.
// The owner's capture uses capture-health.ts's rule over his sync_state row (capture-read.ts):
// red when he has no usable grant, or when his last successful cron step is over 30 minutes
// old. Each step stamps `last_ok_at` whether or not it harvested, so a quiet evening stays green.
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
  /** The worst of the stored app-wide budget mode and the daily record's; null = neither readable. */
  budgetMode: Mode | null;
  /** Since the meter's last write (Infinity = never); null = not measurable. */
  meterAgeMs: number | null;
  /** Phase 4a's conditions, from the app database (app-db.ts readHealth); absent before it. */
  app?: AppHealth;
};

/** What the app database says (PLAN.md §7.10, Phase 4a): events not yet reported, by code, and
 *  users stuck in a state someone must act on. Counts only: nothing about anyone's listening. */
export type AppHealth = {
  events: Record<string, number>;
  /** `revoked` or `deleting` for over a day: a deletion that is not finishing (§12.3). */
  stuckDeletions: number;
  /** A friend `needs_reconnect` for over six hours. */
  reconnect: number;
  /** A friend in `backoff` with no success for over six hours. */
  backoff: number;
  /** A friend `removed` from the allowlist for over seven days: Rem's `user.mjs --remove`. */
  removed: number;
};

export type HealthReason =
  | "isolation"
  | "grant"
  | "event"
  | "owner-capture"
  | "daily"
  | "quota-pace"
  | "budget"
  | "meter"
  | "deletion"
  | "reconnect"
  | "backoff"
  | "removed";
export type HealthVerdict = { ok: boolean; reasons: HealthReason[]; unchecked: string[] };

export const DAILY_STALE_MS = 26 * 3_600_000;
export const METER_QUIET_MS = 6 * 3_600_000;

// The event codes that mean one user's data, token or database met another's (§6.5).
export const ISOLATION_CODES = ["owner-mismatch", "cache-stamp", "token-owner", "decrypt"];
const GRANT_CODES = ["invalid-grant", "grant-wide", "revoked"];

/** How many of the unreported events are isolation events (the input Phase 1 could not measure). */
export function isolationCount(app: AppHealth): number {
  return ISOLATION_CODES.reduce((n, c) => n + (app.events[c] ?? 0), 0);
}

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
  if (i.app) {
    const codes = Object.keys(i.app.events).filter((c) => i.app!.events[c] > 0);
    if (codes.some((c) => GRANT_CODES.includes(c))) reasons.push("grant");
    if (codes.some((c) => !GRANT_CODES.includes(c) && !ISOLATION_CODES.includes(c))) reasons.push("event");
    if (i.app.stuckDeletions > 0) reasons.push("deletion");
    if (i.app.reconnect > 0) reasons.push("reconnect");
    if (i.app.backoff > 0) reasons.push("backoff");
    if (i.app.removed > 0) reasons.push("removed");
  }
  return { ok: reasons.length === 0, reasons, unchecked };
}
