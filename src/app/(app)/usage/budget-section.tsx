import type { BudgetDayRow } from "@/lib/db";

// The budget (docs/multi-user/CAPACITY.md §6, src/lib/budget/): each hard limit's month-to-date,
// the month at that pace, its share of the limit and its mode, as the daily chores last
// recorded them. Vercel's "so far" is this app's own (the CPU meter); the month adds the team's
// other projects and the meter's calibration. Economy past 60% of a limit, freeze past 80%.

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const count = (v: number) => nf.format(v);
const DIMS: Record<string, { name: string; fmt: (v: number) => string }> = {
  vercel_cpu_ms: { name: "Vercel active CPU", fmt: (v) => `${(v / 3_600_000).toFixed(2)} h` },
  vercel_invocations: { name: "Vercel invocations", fmt: count },
  vercel_cdn_requests: { name: "Vercel CDN requests", fmt: count },
  vercel_origin_bytes: { name: "Vercel origin transfer", fmt: (v) => `${(v / 1e9).toFixed(2)} GB` },
  turso_rows_read: { name: "Turso rows read", fmt: count },
  turso_rows_written: { name: "Turso rows written", fmt: count },
};
const ORDER = Object.keys(DIMS);

export function BudgetSection({ rows, down }: { rows: BudgetDayRow[]; down: boolean }) {
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.dimension) - ORDER.indexOf(b.dimension));
  return (
    <section className="mt-12">
      <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
        <h2 className="font-mono text-sm">budget</h2>
        <p className="text-sm text-muted-foreground">
          {rows[0] ? `month to date · as of ${rows[0].day}` : "month to date"}
        </p>
      </div>
      {down ? (
        <p className="mt-3 text-sm text-muted-foreground">Unavailable — the log store did not answer.</p>
      ) : sorted.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing recorded yet — the daily chores write the first record.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-1 w-full min-w-[30rem] text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 text-left font-normal">limit</th>
                <th className="w-24 py-1 text-right font-normal">so far</th>
                <th className="w-24 py-1 text-right font-normal">month at pace</th>
                <th className="w-20 py-1 text-right font-normal">of limit</th>
                <th className="w-20 py-1 text-right font-normal">mode</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const d = DIMS[r.dimension] ?? { name: r.dimension, fmt: count };
                const share = r.projected == null ? null : r.projected / r.limit;
                return (
                  <tr key={r.dimension}>
                    <td className="py-1">
                      {d.name} <span className="text-xs text-muted-foreground">of {d.fmt(r.limit)}</span>
                    </td>
                    <td className="w-24 py-1 text-right tabular-nums">{r.used == null ? "—" : d.fmt(r.used)}</td>
                    <td className="w-24 py-1 text-right tabular-nums">
                      {r.projected == null ? "—" : d.fmt(r.projected)}
                    </td>
                    <td className="w-20 py-1 text-right tabular-nums">
                      {share == null ? "unmeasured" : `${Math.round(share * 100)}%`}
                    </td>
                    <td
                      className={`w-20 py-1 text-right ${
                        r.mode === "freeze"
                          ? "text-destructive"
                          : r.mode === "economy"
                            ? "text-amber-400"
                            : "text-muted-foreground"
                      }`}
                    >
                      {r.mode}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
