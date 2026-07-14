"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { DayStats } from "@/lib/db";
import { dayLabel, formatListenTime, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// Day-strip spans, same ladder as the live app: two weeks → four weeks → everything.
const SPANS = [14, 28, 100000];

// The day strip: cards newest-first (Today leads), each carrying plays and time
// listened. The days scroll horizontally inside a framed tray and extend further
// back via the chevron at the end; the All-time card sits OUTSIDE the tray on the
// right, fixed — same shape as the live app's strip.
export function DayCards({
  daily,
  selected, // day string, or "all"
  allTime,
  onSelect,
  onExtend, // (days) => Promise<void> — loads a longer span into `daily`
}: {
  daily: DayStats[]; // newest first, as the DB returns it
  selected: string;
  allTime: { plays: number; durationMs: number; since: string | null };
  onSelect: (day: string) => void;
  onExtend: (days: number) => Promise<void>;
}) {
  const [level, setLevel] = useState(0);
  const [extending, setExtending] = useState(false);
  const canExtend = level < SPANS.length - 1;

  const extend = async () => {
    if (extending || !canExtend) return;
    setExtending(true);
    try {
      await onExtend(SPANS[level + 1]);
      setLevel(level + 1);
    } finally {
      setExtending(false);
    }
  };

  const card = (active: boolean) =>
    cn(
      // Sized so exactly 5 days stand full and the 6th is mostly cut by the edge fade — enough
      // to read the date and the first digit, not the whole figure. 6 visible would read as
      // "almost a week" and invite the question of why it isn't just a week.
      "min-w-[143px] shrink-0 snap-start rounded-xl border p-3.5 text-left transition-colors",
      active
        ? "border-[color-mix(in_srgb,var(--bamboo)_55%,var(--border))] bg-white/[0.05]"
        : "border-border bg-card hover:border-[color-mix(in_srgb,var(--border)_55%,var(--muted-foreground))]",
    );

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      {/* Scrollable days tray */}
      <div className="min-w-0 flex-1 rounded-xl border border-border/60 bg-white/[0.015] p-1.5">
        <div className="thin-scroll flex snap-x gap-2 overflow-x-auto overscroll-x-contain [touch-action:pan-x] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]">
          {daily.map((d) => (
            <button
              key={d.day}
              type="button"
              onClick={() => onSelect(d.day)}
              aria-pressed={selected === d.day}
              className={card(selected === d.day)}
            >
              <div className="text-sm font-semibold">{dayLabel(d.day)}</div>
              {/* Flex gap, not a text space: a literal " " here renders at the parent's
                  text-xl size, so the gap was both oversized and optically inconsistent
                  between numbers (a trailing 7 opens up more whitespace than a 2). */}
              <div className="mt-2 flex items-baseline gap-1.5 text-xl font-semibold tabular-nums">
                <span>{d.plays}</span>
                <span className="text-xs font-normal text-muted-foreground">plays</span>
              </div>
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                {formatListenTime(d.durationMs)}
              </div>
            </button>
          ))}
          {canExtend ? (
            <button
              type="button"
              onClick={extend}
              disabled={extending}
              aria-label={level === 0 ? "Show two more weeks" : "Show all days"}
              title={level === 0 ? "Show two more weeks" : "Show all days"}
              className="flex shrink-0 items-center gap-1 self-stretch px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {level >= 1 ? <span>See all</span> : null}
              <ChevronRight className={cn("size-5", extending && "animate-pulse")} />
            </button>
          ) : null}
        </div>
      </div>

      {/* All-time — fixed reference outside the scroll */}
      <button
        type="button"
        onClick={() => onSelect("all")}
        aria-pressed={selected === "all"}
        className={cn(card(selected === "all"), "sm:min-w-[150px]")}
      >
        <div className="text-sm font-semibold">All time</div>
        <div className="mt-2 flex items-baseline gap-1.5 text-xl font-semibold tabular-nums">
          <span>{allTime.plays}</span>
          <span className="text-xs font-normal text-muted-foreground">plays</span>
        </div>
        <div className="mt-1 text-xs tabular-nums text-muted-foreground">
          {formatListenTime(allTime.durationMs)}
        </div>
        {allTime.since ? (
          <div className="text-xs tabular-nums text-muted-foreground/70">
            since {shortDate(allTime.since)}
          </div>
        ) : null}
      </button>
    </div>
  );
}
