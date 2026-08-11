import { getClientMetricsSummary, readLedger, type LedgerRow } from "@/lib/db";

// The instrument panel for the rows-read quota — the ledger written by every named read path
// (src/lib/read-costs.ts owns the model, db.ts "The read-cost ledger" owns the storage),
// with the platform counter and the unexplained residual the daily cron reconciles into it.
//
// Deliberately plain. This is not a product surface: it is the page you open when the number
// on Turso's dashboard moves and you want to know which path moved it. No chart, no client
// JS, no link in the nav — it costs nothing while nobody is looking at it.
//
// Auth is the (app) layout's job (it redirects without a session), same as every other page
// in the group.
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

function byDay(rows: LedgerRow[]): { day: string; rows: LedgerRow[] }[] {
  const days: { day: string; rows: LedgerRow[] }[] = [];
  for (const r of rows) {
    const last = days[days.length - 1];
    if (last && last.day === r.day) last.rows.push(r);
    else days.push({ day: r.day, rows: [r] });
  }
  return days;
}

export default async function UsagePage() {
  const [ledger, counters, clientMetrics] = await Promise.all([
    readLedger(DAYS),
    liveCounters(),
    getClientMetricsSummary(),
  ]);
  const days = byDay(ledger);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <h1 className="den-display text-4xl leading-tight tracking-tight sm:text-5xl">Usage</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Modeled rows read per reader per UTC day, against what Turso actually billed.{" "}
        <span className="font-mono">_platform_total</span> is the meter,{" "}
        <span className="font-mono">_residual</span> is what the model does not explain.
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

      {days.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No ledger rows yet — nothing has been attributed on this database.
        </p>
      ) : (
        days.map(({ day, rows }) => {
          // The reserved rows are the reconciliation's own output, not spend, so they are
          // called out separately and kept out of the day's modeled total.
          const spend = rows.filter((r) => !r.reader.startsWith("_"));
          const meta = rows.filter((r) => r.reader.startsWith("_"));
          const total = spend.reduce((n, r) => n + r.modeledRows, 0);
          return (
            <section key={day} className="mt-8">
              <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
                <h2 className="font-mono text-sm">{day}</h2>
                <p className="text-sm tabular-nums text-muted-foreground">
                  {nf.format(total)} modeled
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="py-1 text-left font-normal">reader</th>
                    <th className="w-20 py-1 text-right font-normal">calls</th>
                    <th className="w-32 py-1 text-right font-normal">modeled rows</th>
                  </tr>
                </thead>
                <tbody>
                  {[...spend, ...meta].map((r) => (
                    <tr
                      key={r.reader}
                      className={
                        r.reader.startsWith("_")
                          ? "border-t border-border/40 text-muted-foreground"
                          : ""
                      }
                    >
                      <td className="py-1 font-mono text-xs">{r.reader}</td>
                      <td className="w-20 py-1 text-right tabular-nums">{nf.format(r.calls)}</td>
                      <td className="w-32 py-1 text-right tabular-nums">
                        {nf.format(r.modeledRows)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}

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
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 text-left font-normal">page</th>
                <th className="w-16 py-1 text-right font-normal">views</th>
                <th className="w-20 py-1 text-right font-normal">lcp p50</th>
                <th className="w-20 py-1 text-right font-normal">lcp p95</th>
                <th className="w-24 py-1 text-right font-normal">data p50</th>
                <th className="w-24 py-1 text-right font-normal">data p95</th>
                <th className="w-24 py-1 text-right font-normal">hist p50</th>
                <th className="w-24 py-1 text-right font-normal">hist p95</th>
                <th className="w-20 py-1 text-right font-normal">visit</th>
              </tr>
            </thead>
            <tbody>
              {clientMetrics.map((p) => (
                <tr key={p.page}>
                  <td className="py-1 font-mono text-xs">{p.page}</td>
                  <td className="w-16 py-1 text-right tabular-nums">{nf.format(p.views)}</td>
                  <td className="w-20 py-1 text-right tabular-nums">{ms(p.stats.lcp?.p50)}</td>
                  <td className="w-20 py-1 text-right tabular-nums">{ms(p.stats.lcp?.p95)}</td>
                  <td className="w-24 py-1 text-right tabular-nums">
                    {ms(p.stats["data-rendered"]?.p50)}
                  </td>
                  <td className="w-24 py-1 text-right tabular-nums">
                    {ms(p.stats["data-rendered"]?.p95)}
                  </td>
                  <td className="w-24 py-1 text-right tabular-nums">
                    {ms(p.stats["history-ready"]?.p50)}
                  </td>
                  <td className="w-24 py-1 text-right tabular-nums">
                    {ms(p.stats["history-ready"]?.p95)}
                  </td>
                  <td className="w-20 py-1 text-right tabular-nums">{ms(p.avgVisitMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
