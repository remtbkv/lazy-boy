import { timingSafeEqual } from "node:crypto";

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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const token = process.env.TURSO_PLATFORM_TOKEN;
  const org = process.env.TURSO_ORG;
  if (!token || !org) {
    return Response.json(
      { ok: false, error: "unconfigured: TURSO_PLATFORM_TOKEN / TURSO_ORG missing" },
      { status: 500 },
    );
  }
  const allowance = Number(new URL(req.url).searchParams.get("allowance")) || DEFAULT_ALLOWANCE;
  let usage: Record<string, number>;
  try {
    const res = await fetch(`https://api.turso.tech/v1/organizations/${org}/usage`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return Response.json(
        { ok: false, error: `platform API ${res.status}` },
        { status: 500 },
      );
    }
    const body = (await res.json()) as {
      organization?: { usage?: Record<string, number> };
    };
    usage = body.organization?.usage ?? {};
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "usage fetch failed" },
      { status: 500 },
    );
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
  return Response.json(
    { ok: breached.length === 0, monthFrac: Number(monthFrac.toFixed(4)), allowance, breached, dims },
    { status: breached.length === 0 ? 200 : 500 },
  );
}
