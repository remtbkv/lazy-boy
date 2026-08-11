import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getClientMetricsSummary, readLedger, type MetricStat } from "@/lib/db";
import { LedgerDays } from "./ledger-days";

// The instrument panel for the rows-read quota — the ledger written by every named read path
// (src/lib/read-costs.ts owns the model, db.ts "The read-cost ledger" owns the storage),
// with the platform counter and the unexplained residual the daily cron reconciles into it.
//
// Deliberately plain. This is not a product surface: it is the page you open when the metered
// number moves and you want to know which path moved it. No chart, no link in the nav — it
// costs nothing while nobody is looking at it. The one piece of client JS is the day pager
// (ledger-days.tsx): the whole window is fetched HERE, once, and paged in the browser, so
// walking back through a fortnight cannot spend a single billed row on the store it watches.
//
// Auth is gated HERE, not left to the (app) layout: Next renders layout and page in
// parallel, so the layout's redirect alone still flushes the page's data into the 307
// body (docs/SECURITY.md).
export const dynamic = "force-dynamic";

const DAYS = 14;
// The org counters are a nice-to-have here: the page's job is the ledger, and the platform
// API has hung for 20+ minutes before now. It gets a short window and is dropped silently.
const COUNTER_TIMEOUT_MS = 4_000;

const LIMITS: Record<string, number> = {
  rows_read: 500_000_000,
  rows_written: 10_000_000,
  bytes_synced: 3 * 1024 ** 3,
  storage_bytes: 5 * 1024 ** 3,
};

const nf = new Intl.NumberFormat("en-US");

/** The org's live month-to-date usage, or null if it isn't cheaply available. */
async function liveCounters(): Promise<Record<string, number> | null> {
  const token = process.env.TURSO_PLATFORM_TOKEN;
  const org = process.env.TURSO_ORG;
  if (!token || !org) return null;
  try {
    const res = await fetch(`https://api.turso.tech/v1/organizations/${org}/usage`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(COUNTER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { organization?: { usage?: Record<string, number> } };
    return body.organization?.usage ?? null;
  } catch {
    return null;
  }
}

/** A duration as the eye reads it: sub-second in ms, longer in seconds. `—` when the event
 *  has no samples on that page yet. */
function ms(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

/** Layout shift is unitless, and rounding it to a millisecond figure would read as zero. */
function cls(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(2);
}

/** One event's typical value with its bad tail beside it, muted — the p95 is what a slow load
 *  felt like, the p50 is what the page usually is. */
function pair(stat: MetricStat | undefined, fmt: (v: number | null | undefined) => string) {
  return (
    <>
      {fmt(stat?.p50)}
      <span className="text-muted-foreground"> / {fmt(stat?.p95)}</span>
    </>
  );
}

export default async function UsagePage() {
  const session = await auth();
  if (!session || session.error) redirect("/login");
  const [ledger, counters, clientMetrics] = await Promise.all([
    readLedger(DAYS),
    liveCounters(),
    getClientMetricsSummary(),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <h1 className="den-display text-4xl leading-tight tracking-tight sm:text-5xl">Usage</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Modeled rows read per reader per UTC day, against what Turso actually billed.{" "}
        <span className="font-mono">_platform_total</span> is the meter,{" "}
        <span className="font-mono">_residual</span> is what the model does not explain. One day
        at a time — <span className="font-mono">←</span> / <span className="font-mono">→</span> walk
        the last {DAYS}.
      </p>

      {counters && (
        <ul className="mt-7 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border/60 pt-4 text-sm sm:grid-cols-4">
          {Object.keys(LIMITS).map((key) => {
            const used = Number(counters[key]) || 0;
            return (
              <li key={key}>
                <p className="font-mono text-xs text-muted-foreground">{key}</p>
                <p className="tabular-nums">
                  {nf.format(used)}{" "}
                  <span className="text-muted-foreground">
                    ({((used / LIMITS[key]) * 100).toFixed(1)}%)
                  </span>
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <LedgerDays ledger={ledger} />

      {/* What the browser measured on real loads (src/lib/metrics-client.ts collects it,
          db.ts's `client_metrics` stores it) — the other half of this page: the ledger above
          is what the app spends, this is what the app feels like. */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
          <h2 className="font-mono text-sm">client metrics</h2>
          <p className="text-sm text-muted-foreground">last 7 days</p>
        </div>
        {clientMetrics.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No client metrics yet — nothing has been reported from a browser.
          </p>
        ) : (
          // p50 and p95 share a cell: five timings at two percentiles each would be ten
          // columns on a 3xl page, and the pair is read together anyway — typical, then the
          // bad tail muted beside it.
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 text-left font-normal">page</th>
                <th className="w-14 py-1 text-right font-normal">views</th>
                <th className="w-14 py-1 text-right font-normal">errors</th>
                <th className="w-24 py-1 text-right font-normal">lcp</th>
                <th className="w-24 py-1 text-right font-normal">inp</th>
                <th className="w-20 py-1 text-right font-normal">cls</th>
                <th className="w-24 py-1 text-right font-normal">data</th>
                <th className="w-24 py-1 text-right font-normal">hist</th>
                <th className="w-16 py-1 text-right font-normal">visit</th>
              </tr>
            </thead>
            <tbody>
              {clientMetrics.map((p) => (
                <tr key={p.page}>
                  <td className="py-1 font-mono text-xs">{p.page}</td>
                  <td className="w-14 py-1 text-right tabular-nums">{nf.format(p.views)}</td>
                  {/* A js-error count is the one number here that is a defect, not a speed —
                      it stays plain at zero and goes red the moment the page throws. */}
                  <td
                    className={`w-14 py-1 text-right tabular-nums ${
                      p.errors > 0 ? "text-destructive" : "text-muted-foreground/50"
                    }`}
                  >
                    {nf.format(p.errors)}
                  </td>
                  <td className="w-24 py-1 text-right tabular-nums">{pair(p.stats.lcp, ms)}</td>
                  <td className="w-24 py-1 text-right tabular-nums">{pair(p.stats.inp, ms)}</td>
                  <td className="w-20 py-1 text-right tabular-nums">{pair(p.stats.cls, cls)}</td>
                  <td className="w-24 py-1 text-right tabular-nums">
                    {pair(p.stats["data-rendered"], ms)}
                  </td>
                  <td className="w-24 py-1 text-right tabular-nums">
                    {pair(p.stats["history-ready"], ms)}
                  </td>
                  <td className="w-16 py-1 text-right tabular-nums">{ms(p.avgVisitMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
