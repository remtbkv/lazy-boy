import "server-only";
import { ledgerAdd, ledgerDayModeledTotal, ledgerSet } from "@/lib/db";
import { USAGE_CHECK_ROWS, residualVerdict } from "@/lib/read-costs";

// DORMANT since 2026-08-08, and deliberately still wired. Production's store is a self-hosted
// sqld on the Zenbook (docs/quota-forensic/BRIDGE.md) which meters nothing, so the pace check
// below watches a Turso database the app no longer reads or writes. It stays because it is the
// guard a fallback to Turso would need on its first day, and because its second half — the
// reconciliation — is what writes the platform total and the residual into the read-cost ledger
// that /usage renders. Only the pace half is dormant; the ledger is live (docs/READ_QUOTA.md).
//
// The quota guard. Twice in one week a metered Turso dimension was discovered at 86% by
// accident (syncs on Aug 3, rows read on Aug 6, both from a dashboard visit) — this route
// is the standing mechanism that replaces that luck. It reads the org's real usage from
// Turso's platform API — the same counter that blocks the database, not a self-maintained
// model of it — and fails the request when any dimension is ahead of its month line. A
// daily cron-job.org job calls it with failure notifications on, so a breach lands in
// Rem's inbox while there is still headroom.
//
// Needs in the environment:
//   TURSO_PLATFORM_TOKEN  a platform API token (dashboard → Account → API Tokens, or
//                         `turso auth api-tokens mint`). NOT the database auth token.
//   TURSO_ORG             the organization slug the database lives in.
// Unconfigured or unreachable = HTTP 500, deliberately: a guard that silently skips is
// the exact failure mode it exists to kill.
//
// Free-plan monthly limits (docs.turso.tech/help/usage-and-billing, verified 2026-08-06).
// If the plan changes, change these — the response names each limit so a stale value is
// visible in the email.
const LIMITS: Record<string, number> = {
  rows_read: 500_000_000,
  rows_written: 10_000_000,
  bytes_synced: 3 * 1024 ** 3,
  storage_bytes: 5 * 1024 ** 3,
};
// A dimension breaches when its used fraction exceeds the elapsed fraction of the month
// times this allowance (burning faster than 1.5× the even pace), or 90% absolute. The
// trip test overrides allowance via ?allowance= so the breach path is provable on demand.
const DEFAULT_ALLOWANCE = 1.5;
const ABSOLUTE_CEILING = 0.9;

// The database whose per-day usage is reconciled. Named rather than derived from
// TURSO_DATABASE_URL so a URL format change can't silently point the reconciliation at
// nothing; override only if the database is renamed.
const DATABASE_NAME = process.env.TURSO_DATABASE_NAME || "lazy-boy";
// The platform API hung for over 20 minutes on 2026-08-08. Whatever it does, it does not get
// to hold the guard open — a reconciliation that can't complete is recorded and skipped.
const PLATFORM_TIMEOUT_MS = 15_000;

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** One UTC day's real rows_read for this database, from Turso's windowed usage endpoint.
 *
 *  SWAPPABLE ON PURPOSE — this is the one part of the reconciliation we cannot verify
 *  locally, and the windowed endpoint is unproven: production reads are quota-blocked as this
 *  ships, and the same API hung for 20+ minutes the night before. If it turns out to be
 *  unreliable (or to report a window that doesn't line up with the quota's own day), the
 *  replacement is a different STRATEGY behind this same signature: snapshot the org's
 *  month-to-date total every day and difference consecutive snapshots. Nothing outside this
 *  function knows which one is in use.
 *
 *  Returns null on any failure — a hang, an error status, or a body without the field. The
 *  caller records that and does NOT alarm: "the API was down" is not evidence of a leak. */
async function fetchPlatformDayUsage(
  day: string,
  org: string,
  token: string,
): Promise<number | null> {
  const from = `${day}T00:00:00Z`;
  const to = `${utcDay(Date.parse(`${day}T00:00:00Z`) + 86_400_000)}T00:00:00Z`;
  try {
    const res = await fetch(
      `https://api.turso.tech/v1/organizations/${org}/databases/${DATABASE_NAME}/usage` +
        `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      database?: {
        total?: Record<string, number>;
        instances?: Record<string, Record<string, number>>;
      };
    };
    // Prefer the pre-summed total; fall back to summing the per-instance figures, which is
    // what the shape degrades to when a database has been migrated between instances (this
    // one was, on 2026-08-06 — the old instance's counters are frozen and still listed).
    const total = body.database?.total?.rows_read;
    if (typeof total === "number") return total;
    const instances = body.database?.instances;
    if (instances) {
      let sum = 0;
      let seen = false;
      for (const v of Object.values(instances)) {
        if (typeof v?.rows_read === "number") {
          sum += v.rows_read;
          seen = true;
        }
      }
      if (seen) return sum;
    }
    return null;
  } catch {
    return null;
  }
}

/** The organization's month-to-date usage from Turso's platform API (`rows_read`,
 *  `rows_written`, ...): the read the pace check below makes, and the one the daily budget
 *  chore imports (src/lib/budget/daily.ts). Throws when unconfigured, unreachable or refused. */
export async function fetchOrgUsage(): Promise<Record<string, number>> {
  const token = process.env.TURSO_PLATFORM_TOKEN;
  const org = process.env.TURSO_ORG;
  if (!token || !org) throw new Error("unconfigured: TURSO_PLATFORM_TOKEN / TURSO_ORG missing");
  const res = await fetch(`https://api.turso.tech/v1/organizations/${org}/usage`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`platform API ${res.status}`);
  const body = (await res.json()) as {
    organization?: { usage?: Record<string, number> };
  };
  return body.organization?.usage ?? {};
}

export type UsageCheckResult = { status: number; body: Record<string, unknown> };

/** The pace check and the reconciliation, as the route's status + JSON body. `allowance`
 *  overrides the pace multiplier (the route's ?allowance=, for the trip test). Called by
 *  /api/cron/usage-check, which turns a 500 into an alarm for its external caller, and by
 *  /api/cron/daily, which only records it (it notifies nobody). */
export async function runUsageCheck(allowance = DEFAULT_ALLOWANCE): Promise<UsageCheckResult> {
  const token = process.env.TURSO_PLATFORM_TOKEN;
  const org = process.env.TURSO_ORG;
  if (!token || !org) {
    return {
      status: 500,
      body: { ok: false, error: "unconfigured: TURSO_PLATFORM_TOKEN / TURSO_ORG missing" },
    };
  }
  let usage: Record<string, number>;
  try {
    usage = await fetchOrgUsage();
  } catch (e) {
    return {
      status: 500,
      body: { ok: false, error: e instanceof Error ? e.message : "usage fetch failed" },
    };
  }
  // Turso quotas reset on the calendar month (UTC).
  const now = new Date();
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const monthFrac = day / daysInMonth;

  const dims = Object.entries(LIMITS).map(([key, limit]) => {
    const used = Number(usage[key]) || 0;
    const frac = used / limit;
    return {
      key,
      used,
      limit,
      frac: Number(frac.toFixed(4)),
      breach: frac >= Math.min(monthFrac * allowance, ABSOLUTE_CEILING),
    };
  });
  const breached = dims.filter((d) => d.breach).map((d) => d.key);

  // ── Reconciliation: the model against the meter ────────────────────────────────────────
  // The pace check above answers "am I burning too fast"; it cannot answer "on what". That
  // is what the ledger is for. Yesterday is the last CLOSED UTC day — reconciling today
  // would diff a partial ledger against a partial counter and produce noise. Both sides are
  // written back into the ledger so /usage shows the model, the meter and the gap together.
  const reconcileDay = utcDay(Date.now() - 86_400_000);
  const platformRows = await fetchPlatformDayUsage(reconcileDay, org, token);
  let reconcile: Record<string, unknown>;
  let residualAlarm = false;
  if (platformRows === null) {
    // Recorded, not alarmed: an unreachable platform API is a gap in the instrument, and
    // paging Rem for it would train him to ignore the one email that matters.
    await ledgerSet(reconcileDay, "_platform_error", 0);
    reconcile = { day: reconcileDay, error: "platform day usage unavailable" };
  } else {
    const modeled = await ledgerDayModeledTotal(reconcileDay);
    const verdict = residualVerdict(platformRows, modeled);
    await ledgerSet(reconcileDay, "_platform_total", platformRows);
    await ledgerSet(reconcileDay, "_residual", verdict.residual);
    residualAlarm = verdict.alarm;
    reconcile = {
      day: reconcileDay,
      platformRows,
      modeledRows: modeled,
      residual: verdict.residual,
      threshold: verdict.threshold,
      alarm: verdict.alarm,
    };
  }
  void ledgerAdd("usage_check", USAGE_CHECK_ROWS);

  const ok = breached.length === 0 && !residualAlarm;
  return {
    status: ok ? 200 : 500,
    body: {
      ok,
      monthFrac: Number(monthFrac.toFixed(4)),
      allowance,
      breached,
      dims,
      reconcile,
    },
  };
}
