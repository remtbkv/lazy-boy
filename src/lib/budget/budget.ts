// The budget guard (docs/multi-user/CAPACITY.md §6): for each hard limit the app can overrun,
// project the month from month-to-date usage and set a mode from the projection's share of the
// limit. "Enough room" is CAPACITY's one rule: the projected month at or under half the hard
// limit. Pure; daily.ts feeds it the meter's and Turso's month-to-date and stores what it says.
//
// Two of the four Vercel figures are not this app's own measurement, and say so below: the
// team's other projects (monitor, website, cheffing) share every Hobby allowance and nothing
// here can read their usage, so each dimension carries a fixed allowance for them; and the CDN
// count includes static assets no function sees.
import { MODES, type Mode } from "@/lib/budget/modes";

export type Dimension =
  | "vercel_cpu_ms"
  | "vercel_invocations"
  | "vercel_origin_bytes"
  | "vercel_cdn_requests"
  | "turso_rows_read"
  | "turso_rows_written";

export const DIMENSIONS: readonly Dimension[] = [
  "vercel_cpu_ms",
  "vercel_invocations",
  "vercel_origin_bytes",
  "vercel_cdn_requests",
  "turso_rows_read",
  "turso_rows_written",
];

const H = 3_600_000;

/** The hard monthly limits (CAPACITY §2 and §3: Vercel Hobby, per team; Turso's free plan, per
 *  organization). Passing one stops every project on the team for up to 30 days (Vercel) or
 *  blocks every query until the 1st (Turso). */
export const HARD_LIMITS: Record<Dimension, number> = {
  vercel_cpu_ms: 4 * H,
  vercel_invocations: 1_000_000,
  // 10 GB, read as decimal gigabytes: the smaller reading, so the share errs high.
  vercel_origin_bytes: 10e9,
  vercel_cdn_requests: 1_000_000,
  turso_rows_read: 500_000_000,
  turso_rows_written: 10_000_000,
};

/** Normal while the projection is at or under this share of the hard limit (the "room" rule). */
export const ROOM = 0.5;
/** Economy past this share, freeze past the next; between ROOM and ECONOMY_ABOVE a dimension
 *  keeps what it was, so it does not flap at a boundary (back to normal only at ROOM). */
export const ECONOMY_ABOVE = 0.6;
export const FREEZE_ABOVE = 0.8;

/** The meter's CPU against Vercel's Active CPU. 1.0 until lane 1946_lb_capacity_05 compares a
 *  72-hour reading of the meter with Rem's dashboard (CAPACITY §6, §7). It multiplies the
 *  metered CPU only, not the other projects' allowance. */
export const CPU_CALIBRATION = 1.0;

/** The team's other projects, a month, added after the projection. CPU and invocations are
 *  CAPACITY §2.2's five-user table ("the others at ≤ 0.3 h"; "~1,670 others" a day × 30);
 *  CDN requests are the same table's "~3,500 others" a day × 30; origin transfer is the other
 *  projects' whole Fast Data Transfer in §2.1's 31 days (0.63 GB less lazy-boy's 0.036 GB),
 *  taken as a bound on what their functions send the CDN. Lane 05 replaces them with the
 *  dashboard's per-project figures. Turso's figures are the organization's own: no allowance. */
export const OTHER_PROJECTS: Record<Dimension, number> = {
  vercel_cpu_ms: 0.3 * H,
  vercel_invocations: 50_000,
  vercel_origin_bytes: 0.6e9,
  vercel_cdn_requests: 105_000,
  turso_rows_read: 0,
  turso_rows_written: 0,
};

/** CDN requests per function invocation of this app: invocations plus the static assets
 *  a browser fetches (CAPACITY §2.2: ~1,100 against ~1,000 for an app-heavy user). */
export const CDN_REQUESTS_PER_INVOCATION = 1.1;

/** A projection made in a month's first minutes extrapolates from at least this much of it. */
const MIN_ELAPSED_MS = H;

/** The UTC calendar month `now` is in (Turso resets on it; CAPACITY §6 uses it for Vercel). */
export function monthSpan(now: number): { start: number; end: number } {
  const d = new Date(now);
  return {
    start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/** The month's total at the pace month-to-date has run. */
export function projectMonth(used: number, now: number): number {
  const { start, end } = monthSpan(now);
  return (used * (end - start)) / Math.max(now - start, MIN_ELAPSED_MS);
}

export function nextMode(prev: Mode, fraction: number): Mode {
  if (fraction > FREEZE_ABOVE) return "freeze";
  if (fraction > ECONOMY_ABOVE) return "economy";
  if (fraction <= ROOM) return "normal";
  return prev === "normal" ? "normal" : "economy";
}

export function worstMode(modes: readonly Mode[]): Mode {
  return modes.reduce<Mode>((w, m) => (MODES.indexOf(m) > MODES.indexOf(w) ? m : w), "normal");
}

/** Month-to-date from the meter (this app's functions only). */
export type MeterTotals = { cpuUs: number; invocations: number; bytes: number };
/** Month-to-date from Turso's platform API (the organization's). */
export type TursoTotals = { rows_read?: number; rows_written?: number };

export type DimensionBudget = {
  dimension: Dimension;
  /** Month-to-date as measured; null = not measurable today (that source did not answer). */
  used: number | null;
  /** The month at that pace, with the calibration and the other projects' allowance. */
  projected: number | null;
  limit: number;
  fraction: number | null;
  mode: Mode;
};

function measured(inputs: { meter: MeterTotals | null; turso: TursoTotals | null }, d: Dimension): number | null {
  const { meter, turso } = inputs;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (d) {
    case "vercel_cpu_ms":
      return meter ? meter.cpuUs / 1000 : null;
    case "vercel_invocations":
      return meter ? meter.invocations : null;
    case "vercel_origin_bytes":
      return meter ? meter.bytes : null;
    case "vercel_cdn_requests":
      return meter ? meter.invocations * CDN_REQUESTS_PER_INVOCATION : null;
    case "turso_rows_read":
      return turso ? n(turso.rows_read) : null;
    case "turso_rows_written":
      return turso ? n(turso.rows_written) : null;
  }
}

/** Every dimension's projection and mode, and the app's mode (its worst dimension's). `prev`
 *  is each dimension's mode in the last record; `fallbackPrev` stands in for a dimension the
 *  record lacks (the stored app mode). A dimension that could not be measured keeps its mode:
 *  an outage of the meter or of Turso's API never lifts a freeze. */
export function budgetReport(
  inputs: { meter: MeterTotals | null; turso: TursoTotals | null },
  prev: Partial<Record<Dimension, Mode>>,
  fallbackPrev: Mode,
  now: number,
): { dims: DimensionBudget[]; mode: Mode } {
  const dims = DIMENSIONS.map((dimension): DimensionBudget => {
    const was = prev[dimension] ?? fallbackPrev;
    const limit = HARD_LIMITS[dimension];
    const used = measured(inputs, dimension);
    if (used === null) return { dimension, used: null, projected: null, limit, fraction: null, mode: was };
    const factor = dimension === "vercel_cpu_ms" ? CPU_CALIBRATION : 1;
    const projected = projectMonth(used, now) * factor + OTHER_PROJECTS[dimension];
    const fraction = projected / limit;
    return { dimension, used, projected, limit, fraction, mode: nextMode(was, fraction) };
  });
  return { dims, mode: worstMode(dims.map((d) => d.mode)) };
}
