import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getClientLoadSpeed,
  readLedger,
  type ClientMetricsPage,
  type MetricStat,
  type PageOpen,
} from "@/lib/db";
import { tzOffsetMinutes } from "@/lib/tz";
import { LedgerDays } from "./ledger-days";

// The instrument panel for this app's two costs: the seconds it spends on the reader (top) and
// the rows it spends on the store (bottom).
//
// LOAD SPEED IS THE HEADLINE, and it is written as a story rather than as variable names: each
// page is one line of named parts in the order they appear, p50 with the bad tail beside it,
// then the last handful of real opens so a slow one is visible as a row rather than hidden in
// a percentile. The parts are the ones that genuinely have separate timings — Home's day
// strip, all-time card and song list arrive in ONE server payload and mount together, so they
// are one part with all three named in its label, not three rows pretending to be independent
// (src/lib/metrics-client.ts documents every mark and where it is made).
//
// The rows-read ledger sits below it: same page, different question — not "how fast was it"
// but "what did that read path cost". Deliberately plain, no chart, no link in the nav — it
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

/** One page's load story: the visible parts, in the order the reader meets them. `label` is
 *  the plain-words name in the story line; `col` is its (shorter) column head in the open
 *  list. An event with no samples still holds its place — a part that stopped reporting is
 *  itself the finding. */
type Part = { event: string; label: string; col: string };
const STORIES: { page: string; title: string; parts: Part[] }[] = [
  {
    page: "/home",
    title: "Home",
    parts: [
      { event: "fcp", label: "first paint", col: "paint" },
      // One mark, three visible things: the home payload is a single materialized read, so the
      // day strip, the all-time card and the opening day's song list cannot be timed apart.
      { event: "data-rendered", label: "page data · day cards, all-time, song list", col: "data" },
      { event: "history-ready", label: "history in memory · day sliding stops asking", col: "history" },
      { event: "now-playing-ready", label: "now playing answered", col: "playing" },
      { event: "dock-ready", label: "dock library", col: "dock" },
    ],
  },
  {
    page: "/playlists",
    title: "Playlists",
    parts: [
      { event: "fcp", label: "first paint", col: "paint" },
      { event: "playlists-rendered", label: "playlist grid · tiles, counts, sort", col: "grid" },
      { event: "now-playing-ready", label: "now playing answered", col: "playing" },
    ],
  },
];

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

/** When an open happened, on the reader's clock. This page renders on the server (UTC on
 *  Vercel), so the browser's offset — the same `tzoffset` cookie the history day-bucketing
 *  reads — is applied by hand instead of trusting the runtime's zone. */
function openTime(iso: string, tzMin: number): string {
  const shifted = new Date(new Date(iso).getTime() + tzMin * 60_000);
  return shifted.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
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

/** One page's load story + its recent opens. */
function LoadStory({
  story,
  summary,
  opens,
  tz,
}: {
  story: (typeof STORIES)[number];
  summary: ClientMetricsPage | undefined;
  opens: PageOpen[];
  tz: number;
}) {
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1">
        <h3 className="text-sm">
          {story.title} <span className="font-mono text-xs text-muted-foreground">{story.page}</span>
        </h3>
        <p className="text-xs tabular-nums text-muted-foreground">
          {nf.format(summary?.views ?? 0)} opens
        </p>
      </div>

      {/* The story: left to right in the order the page assembles itself. */}
      <ol className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-4">
        {story.parts.map((part, i) => (
          <li key={part.event} className="flex items-start gap-3">
            {i > 0 && (
              <span aria-hidden className="pt-4 text-muted-foreground/40">
                →
              </span>
            )}
            <span className="block max-w-[11rem]">
              <span className="block text-[11px] leading-tight text-muted-foreground">
                {part.label}
              </span>
              <span className="mt-0.5 block tabular-nums">
                {ms(summary?.stats[part.event]?.p50)}
                <span className="text-xs text-muted-foreground">
                  {" / "}
                  {ms(summary?.stats[part.event]?.p95)}
                </span>
              </span>
            </span>
          </li>
        ))}
      </ol>

      {opens.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No opens of this page reported in the last 7 days.
        </p>
      ) : (
        // The percentiles above say what the page usually is; this says what each open WAS.
        // A part that didn't report on a given open is `—`, never a zero — an in-app
        // navigation has no first paint of its own, and the player is already answered by the
        // time you arrive, so both legitimately have nothing to say on those rows.
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 text-left font-normal">open</th>
              {story.parts.map((p) => (
                <th key={p.event} className="w-16 py-1 text-right font-normal">
                  {p.col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {opens.map((open, i) => (
              <tr key={`${open.at}-${i}`}>
                <td className="whitespace-nowrap py-1 text-muted-foreground">
                  <span className="tabular-nums text-foreground">{openTime(open.at, tz)}</span>{" "}
                  {open.kind === "load" ? (
                    "load"
                  ) : (
                    <>
                      nav{open.from ? ` from ${open.from}` : ""}
                      {open.parts["nav-ms"] != null && (
                        <span className="tabular-nums"> {ms(open.parts["nav-ms"])}</span>
                      )}
                    </>
                  )}
                  {open.errors > 0 && (
                    <span className="text-destructive"> · {open.errors} error</span>
                  )}
                </td>
                {story.parts.map((p) => (
                  <td key={p.event} className="w-16 py-1 text-right tabular-nums">
                    {ms(open.parts[p.event])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default async function UsagePage() {
  const session = await auth();
  if (!session || session.error) redirect("/login");
  const [ledger, counters, client, tz] = await Promise.all([
    readLedger(DAYS),
    liveCounters(),
    getClientLoadSpeed(),
    tzOffsetMinutes(),
  ]);
  const summaryByPage = new Map(client.pages.map((p) => [p.page, p]));

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <h1 className="den-display text-4xl leading-tight tracking-tight sm:text-5xl">Usage</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        What each page costs to open, measured in the browser that opened it — then what each
        read path costs the store it reads.
      </p>

      {/* ── How fast each visible part arrived ──────────────────────────────────────────── */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
          <h2 className="font-mono text-sm">load speed</h2>
          <p className="text-sm text-muted-foreground">last 7 days · typical / slow</p>
        </div>

        {client.pages.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing measured yet — no browser has reported a page open.
          </p>
        ) : (
          STORIES.map((story) => (
            <LoadStory
              key={story.page}
              story={story}
              summary={summaryByPage.get(story.page)}
              opens={client.opens.filter((o) => o.page === story.page)}
              tz={tz}
            />
          ))
        )}
      </section>

      {/* Everything the load story doesn't cover: how the page answered a tap, how much it
          moved under the reader, whether it threw, and how long it was actually looked at.
          Every page, not just the two with stories — a page with no marks still reports these. */}
      {client.pages.length > 0 && (
        <section className="mt-10">
          <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
            <h2 className="font-mono text-sm">once it&rsquo;s open</h2>
            <p className="text-sm text-muted-foreground">last 7 days</p>
          </div>
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-1 text-left font-normal">page</th>
                <th className="w-14 py-1 text-right font-normal">opens</th>
                <th className="w-14 py-1 text-right font-normal">errors</th>
                <th className="w-24 py-1 text-right font-normal">largest paint</th>
                <th className="w-24 py-1 text-right font-normal">tap response</th>
                <th className="w-20 py-1 text-right font-normal">shift</th>
                <th className="w-16 py-1 text-right font-normal">looked at</th>
              </tr>
            </thead>
            <tbody>
              {client.pages.map((p) => (
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
                  <td className="w-16 py-1 text-right tabular-nums">{ms(p.avgVisitMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* The error COUNT above says something threw; these say WHAT. Verbatim browser
              messages, newest first — without them the count is an anxiety, not a diagnosis. */}
          {client.errors.length > 0 && (
            <ul className="mt-3 space-y-1">
              {client.errors.map((e, i) => (
                <li key={i} className="text-xs leading-relaxed text-muted-foreground">
                  <span className="tabular-nums">{openTime(e.at, tz)}</span>
                  <span className="font-mono"> {e.page} </span>
                  <span className="text-destructive/80">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── What each read path costs the store ─────────────────────────────────────────── */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
          <h2 className="font-mono text-sm">what each read path costs the store</h2>
          <p className="text-sm text-muted-foreground">last {DAYS} days</p>
        </div>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Modeled rows read per reader per UTC day, against what Turso actually billed.{" "}
          <span className="font-mono">_platform_total</span> is the meter,{" "}
          <span className="font-mono">_residual</span> is what the model does not explain. One day
          at a time — <span className="font-mono">←</span> / <span className="font-mono">→</span>{" "}
          walk the last {DAYS}.
        </p>

        {counters && (
          <ul className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border/60 pt-4 text-sm sm:grid-cols-4">
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
      </section>
    </main>
  );
}
