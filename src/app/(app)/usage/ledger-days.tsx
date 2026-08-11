"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { LedgerRow } from "@/lib/db";
import { LEDGER_READERS, RESERVED_READERS, residualVerdict } from "@/lib/read-costs";
import { cn } from "@/lib/utils";

// The ledger, ONE DAY AT A TIME. The whole window arrives from the server in one prop — a
// fortnight is a couple of hundred rows, since the table holds one row per (UTC day, reader)
// — so paging is a state change, not a fetch. Nothing here can spend a billed row, which is
// the point: the page that watches the read budget must not move it while you read it.
//
// Two things make days comparable, and both are deliberate:
//   • FIXED ROW ORDER. Every day draws every known reader, zero-filled, in read-costs.ts's
//     LEDGER_READERS order. A row therefore sits on the same line whichever day is showing,
//     so "what changed" is a vertical scan instead of a re-read of the labels.
//   • A PER-ROW ANCHOR. Each row carries the previous day's modeled rows as a delta, so a
//     path that doubled overnight is legible without holding two screens in your head.
//
// Arrow keys page RIGHT = older, LEFT = newer (Rem's read direction, 2026-08-11): the newest
// day opens first at 1/N, and paging "forward" walks back in time like flipping pages of a
// log. The chevrons are the same action for touch, and for anyone who doesn't guess.

const nf = new Intl.NumberFormat("en-US");

type DayBucket = { day: string; byReader: Map<string, LedgerRow>; modeledTotal: number };

/** The day the ledger keys on is a UTC calendar day (db.ts `utcDay`), so it is labelled in
 *  UTC too — reading it in the browser's zone would shift the label off the row it names. */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Rows per call, at the precision the figure earns: the big modeled paths are five digits
 *  and a decimal is noise, the small ones (~2 rows a call) are all decimal. */
function perCall(rows: number, calls: number): string {
  if (!calls) return "—";
  const v = rows / calls;
  return v >= 100 ? nf.format(Math.round(v)) : v.toFixed(1);
}

function signed(n: number): string {
  return `${n < 0 ? "−" : "+"}${nf.format(Math.abs(n))}`;
}

/** The previous day's row count as a signed delta, or `—` when there is no previous day in
 *  the window to compare against (which is not the same as "no change"). */
function delta(today: number, prev: number | null): string {
  if (prev === null) return "—";
  return today === prev ? "0" : signed(today - prev);
}

export function LedgerDays({ ledger }: { ledger: LedgerRow[] }) {
  // Newest day first, matching readLedger's ordering, so index 0 is the day in progress.
  const days = useMemo<DayBucket[]>(() => {
    const buckets: DayBucket[] = [];
    for (const r of ledger) {
      let last = buckets[buckets.length - 1];
      if (!last || last.day !== r.day) {
        last = { day: r.day, byReader: new Map(), modeledTotal: 0 };
        buckets.push(last);
      }
      last.byReader.set(r.reader, r);
      // The reserved `_` rows are the reconciliation's own output, not spend, so they stay
      // out of the day's modeled total — the same split ledgerDayModeledTotal makes in SQL.
      if (!r.reader.startsWith("_")) last.modeledTotal += r.modeledRows;
    }
    return buckets;
  }, [ledger]);

  // Any reader the ledger holds that read-costs.ts doesn't name yet — a path instrumented
  // since, or a typo'd name. Shown after the canonical block, alphabetically, so it is
  // visible rather than silently dropped.
  const readers = useMemo(() => {
    const known = new Set<string>(LEDGER_READERS);
    const extra = new Set<string>();
    for (const r of ledger) {
      if (!r.reader.startsWith("_") && !known.has(r.reader)) extra.add(r.reader);
    }
    return [...LEDGER_READERS, ...[...extra].sort()];
  }, [ledger]);

  const [index, setIndex] = useState(0);
  const move = useCallback(
    (step: number) => setIndex((i) => Math.min(days.length - 1, Math.max(0, i + step))),
    [days.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // browser history, not us
      // A field with focus owns its own caret movement; stealing arrow keys from it is the
      // classic keyboard-shortcut bug.
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
        return;
      }
      e.preventDefault();
      move(e.key === "ArrowRight" ? 1 : -1); // right goes back in time
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  if (days.length === 0) {
    return (
      <p className="mt-8 text-sm text-muted-foreground">
        No ledger rows yet — nothing has been attributed on this database.
      </p>
    );
  }

  const current = days[Math.min(index, days.length - 1)];
  const prev = days[index + 1] ?? null; // the day before this one, when the window reaches it

  // The meter and the residual for the day, once the daily reconciliation has closed it.
  // Recomputing the verdict here from the SHIPPED function (rather than restating its
  // thresholds) keeps this display and the email that would have fired on the same rule.
  const platform = current.byReader.get("_platform_total")?.modeledRows ?? null;
  const verdict = platform === null ? null : residualVerdict(platform, current.modeledTotal);

  const chevron =
    "flex size-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground disabled:opacity-30 disabled:hover:border-border/60 disabled:hover:text-muted-foreground";

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-1">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-mono text-sm">{current.day}</h2>
          <span className="text-xs text-muted-foreground">{dayLabel(current.day)} UTC</span>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-sm tabular-nums text-muted-foreground">
            {nf.format(current.modeledTotal)} modeled
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={chevron}
              onClick={() => move(-1)}
              disabled={index === 0}
              aria-label="Newer day"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="w-10 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
              {index + 1}/{days.length}
            </span>
            <button
              type="button"
              className={chevron}
              onClick={() => move(1)}
              disabled={index >= days.length - 1}
              aria-label="Older day"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {verdict && (
        <p
          className={cn(
            "mt-1.5 text-xs tabular-nums",
            verdict.alarm ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {nf.format(platform ?? 0)} billed · residual {signed(verdict.residual)} against a{" "}
          {nf.format(Math.round(verdict.threshold))} bar
          {verdict.alarm && " — unexplained, this is the alarm condition"}
        </p>
      )}

      {/* Phones: sideways scroll stays inside this box, never on the page. */}
      <div className="overflow-x-auto">
        <table className="mt-1 w-full min-w-[24rem] text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="py-1 text-left font-normal">reader</th>
            <th className="w-16 py-1 text-right font-normal">calls</th>
            <th className="w-28 py-1 text-right font-normal">rows</th>
            <th className="w-20 py-1 text-right font-normal">rows/call</th>
            <th
              className="w-24 py-1 text-right font-normal"
              title={prev ? `versus ${prev.day}` : "no earlier day in this window"}
            >
              Δ rows
            </th>
          </tr>
        </thead>
        <tbody>
          {readers.map((reader) => {
            const row = current.byReader.get(reader);
            const before = prev ? (prev.byReader.get(reader)?.modeledRows ?? 0) : null;
            const rows = row?.modeledRows ?? 0;
            const changed = before !== null && rows !== before;
            return (
              // A reader with nothing on this day still holds its line, dimmed — the row
              // order is what makes two days comparable, so it must not close up.
              <tr key={reader} className={row ? "" : "text-muted-foreground/50"}>
                <td className="py-1 font-mono text-xs">{reader}</td>
                <td className="w-16 py-1 text-right tabular-nums">{nf.format(row?.calls ?? 0)}</td>
                <td className="w-28 py-1 text-right tabular-nums">{nf.format(rows)}</td>
                <td className="w-20 py-1 text-right tabular-nums text-muted-foreground">
                  {perCall(rows, row?.calls ?? 0)}
                </td>
                <td
                  className={cn(
                    "w-24 py-1 text-right tabular-nums",
                    changed ? "text-muted-foreground" : "text-muted-foreground/40",
                  )}
                >
                  {delta(rows, before)}
                </td>
              </tr>
            );
          })}

          {/* The reconciliation's own rows, kept below the rule and out of the total above.
              `_platform_error` only appears on a day the meter could not be read at all. */}
          {RESERVED_READERS.filter(
            (r) => r !== "_platform_error" || current.byReader.has(r),
          ).map((reader, i) => {
            const row = current.byReader.get(reader);
            const before = prev ? (prev.byReader.get(reader)?.modeledRows ?? 0) : null;
            const rows = row?.modeledRows ?? 0;
            return (
              <tr
                key={reader}
                className={cn(
                  "text-muted-foreground",
                  i === 0 && "border-t border-border/40",
                  !row && "text-muted-foreground/50",
                )}
              >
                <td className="py-1 font-mono text-xs">{reader}</td>
                <td className="w-16 py-1 text-right tabular-nums">{nf.format(row?.calls ?? 0)}</td>
                <td className="w-28 py-1 text-right tabular-nums">{nf.format(rows)}</td>
                {/* Rows-per-call means nothing for a figure the reconciliation SETS once. */}
                <td className="w-20 py-1 text-right tabular-nums text-muted-foreground/40">—</td>
                <td className="w-24 py-1 text-right tabular-nums text-muted-foreground/40">
                  {delta(rows, before)}
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
    </section>
  );
}
