"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { DayStats } from "@/lib/db";
import { dayLabel, formatListenTime, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TouchScrubber } from "@/components/touch-scrubber";

// Day-strip spans: two weeks → four weeks → everything on desktop; the phone opens one
// rung lower (one week → …) so the chevron appears after ~a week of cards instead of a
// long swipe away (Rem, 2026-08-13).
const SPANS = [14, 28, 100000];
const PHONE_SPANS = [7, 14, 28, 100000];

// The day strip: cards newest-first (Today leads), each carrying plays and time
// listened. The days scroll horizontally inside a framed tray and extend further
// back via the chevron at the end; the All-time card sits OUTSIDE the tray on the
// right, fixed — same shape as the live app's strip.
//
// Two shapes, one markup. Desktop keeps the wide cards. The phone runs PORTRAIT cards
// (Rem, 2026-08-12): horizontal space is the scarce axis there, so the same content
// stacks into a fixed 84px column — every card (All-time included) identical in size,
// with All-time in the same row rather than on its own line below.
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
  // Effect, not render-time matchMedia: the server render has no viewport, so the first
  // client render must match it (14 cards) and narrow to 7 after hydration — invisible,
  // since cards past the fourth sit beyond the tray's scroll edge anyway.
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    setPhone(window.matchMedia("(max-width: 639.98px)").matches);
  }, []);
  const spans = phone ? PHONE_SPANS : SPANS;
  const canExtend = level < spans.length - 1;
  const shownDaily = daily.slice(0, spans[level]);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const extend = async () => {
    if (extending || !canExtend) return;
    setExtending(true);
    try {
      await onExtend(spans[level + 1]);
      setLevel(level + 1);
    } finally {
      setExtending(false);
    }
  };

  const card = (active: boolean) =>
    cn(
      // Desktop: sized so exactly 5 days stand full and the 6th is mostly cut by the edge
      // fade — enough to read the date and the first digit, not the whole figure. Phone:
      // a fixed portrait column (see the component note), content spread top-to-bottom.
      "flex w-[92px] min-w-[92px] shrink-0 snap-start flex-col justify-between rounded-xl border px-2.5 py-3 text-left transition-colors sm:w-auto sm:min-w-[143px] sm:justify-start sm:p-3.5",
      active
        ? "border-[color-mix(in_srgb,var(--bamboo)_55%,var(--border))] bg-white/[0.05]"
        : "border-border bg-card hover:border-[color-mix(in_srgb,var(--border)_55%,var(--muted-foreground))]",
    );

  return (
    <div className="flex items-stretch gap-2">
      {/* Scrollable days tray */}
      {/* pb-2 inside the scroller + pb-1 on the tray: the bar hangs clear of the cards
          (8px) and closer to the tray's bottom edge (4px) instead of flush under them. */}
      <div className="min-w-0 flex-1 rounded-xl border border-border/60 bg-white/[0.015] p-1.5 pb-1">
        <div
          ref={scrollerRef}
          className="thin-scroll flex snap-x gap-2 overflow-x-auto overscroll-x-contain pb-1 sm:pb-2 [touch-action:pan-x] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]"
        >
          {shownDaily.map((d) => (
            <button
              key={d.day}
              type="button"
              onClick={() => onSelect(d.day)}
              aria-pressed={selected === d.day}
              className={card(selected === d.day)}
            >
              {/* suppressHydrationWarning: dayLabel() pivots on the clock — "Today"/
                  "Yesterday" are decided against `new Date()` in the RENDERING zone, and the
                  server renders in UTC (Vercel) while the browser renders local. Between the
                  local evening and midnight the two disagree by a calendar day, so the same
                  card is "Yesterday" on the server and "Today" in the browser. */}
              <div suppressHydrationWarning className="text-sm font-semibold">
                {dayLabel(d.day)}
              </div>
              {/* Flex gap, not a text space: a literal " " here renders at the parent's
                  text-xl size, so the gap was both oversized and optically inconsistent
                  between numbers (a trailing 7 opens up more whitespace than a 2). */}
              <div className="mt-2 flex flex-col font-semibold tabular-nums sm:flex-row sm:items-baseline sm:gap-1.5">
                <span className="text-2xl sm:text-xl">{d.plays}</span>
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
              aria-label={spans[level + 1] >= 100000 ? "Show all days" : "Show more days"}
              title={spans[level + 1] >= 100000 ? "Show all days" : "Show more days"}
              className="flex shrink-0 items-center gap-1 self-stretch px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {spans[level + 1] >= 100000 ? <span>See all</span> : null}
              <ChevronRight className={cn("size-5", extending && "animate-pulse")} />
            </button>
          ) : null}
        </div>
        <TouchScrubber scrollerRef={scrollerRef} className="mx-1" />
      </div>

      {/* All-time — fixed reference outside the scroll */}
      <button
        type="button"
        onClick={() => onSelect("all")}
        aria-pressed={selected === "all"}
        className={cn(card(selected === "all"), "sm:min-w-[150px]")}
      >
        <div className="text-sm font-semibold">All time</div>
        <div className="mt-2 flex flex-col font-semibold tabular-nums sm:flex-row sm:items-baseline sm:gap-1.5">
          <span className="text-2xl sm:text-xl">{allTime.plays}</span>
          <span className="text-xs font-normal text-muted-foreground">plays</span>
        </div>
        <div className="mt-1 text-xs tabular-nums text-muted-foreground">
          {formatListenTime(allTime.durationMs)}
        </div>
        {allTime.since ? (
          // suppressHydrationWarning: shortDate() reads the LOCAL calendar date of a UTC
          // instant, so a first play recorded in the local evening lands on one date in the
          // server's UTC render and the previous one in the browser's.
          // Phone: dropped — the portrait card holds three lines, and "since" is the one
          // that isn't a number you compare day to day.
          <div
            suppressHydrationWarning
            className="hidden text-xs tabular-nums text-muted-foreground/70 sm:block"
          >
            since {shortDate(allTime.since)}
          </div>
        ) : null}
      </button>
    </div>
  );
}
