// The daily budget record (docs/multi-user/CAPACITY.md §6), run by the daily chores
// (/api/cron/daily). It reads the meter's month-to-date sums (the telemetry store) and Turso's
// month-to-date usage (the usage check's own platform read), runs budget.ts over them, stores
// one row per dimension for /usage, and writes the app-wide mode the hot paths read.
//
// A source that does not answer leaves its dimensions unmeasured, and each keeps the mode it
// had in the last record (or, with no record, the stored app mode), so an outage never lifts
// economy or freeze. The record going to the telemetry store fails soft; the mode is the one
// write that has to land, and its failure fails the chore where /api/cron/daily shows it.
import "server-only";
import { getBudgetMode, readBudgetDay, readMeter, recordBudgetDay, setBudgetMode } from "@/lib/db";
import { fetchOrgUsage } from "@/lib/usage-check";
import { DIMENSIONS, budgetReport, monthSpan, type Dimension } from "@/lib/budget/budget";
import { isMode, type Mode } from "@/lib/budget/modes";

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const isDimension = (v: string): v is Dimension => (DIMENSIONS as readonly string[]).includes(v);

/** One line for the chores' outcome: the app's mode, then each dimension's share and mode. */
export async function runBudgetChore(now = Date.now()): Promise<string> {
  const [meter, turso, last, stored] = await Promise.all([
    readMeter(utcDay(monthSpan(now).start)).catch(() => null),
    fetchOrgUsage().catch(() => null),
    readBudgetDay().catch(() => []),
    getBudgetMode(0).catch(() => null),
  ]);
  const prev: Partial<Record<Dimension, Mode>> = {};
  for (const r of last) if (isDimension(r.dimension) && isMode(r.mode)) prev[r.dimension] = r.mode;
  const report = budgetReport({ meter, turso }, prev, stored ?? "normal", now);

  const day = utcDay(now);
  const recorded = await recordBudgetDay(
    report.dims.map((d) => ({ ...d, day, at: now })),
  ).then(
    () => true,
    () => false,
  );
  await setBudgetMode(report.mode);
  const dims = report.dims
    .map((d) => `${d.dimension} ${d.fraction === null ? "unmeasured" : `${Math.round(d.fraction * 100)}%`} ${d.mode}`)
    .join(", ");
  return `${report.mode}: ${dims}${recorded ? "" : " (record not stored)"}`;
}
