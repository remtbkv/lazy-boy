"use client";

import { useEffect, useRef, useState } from "react";
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
  const canExtend = level < SPANS.length - 1;
  const scrollerRef = useRef<HTMLDivElement>(null);

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
          {daily.map((d) => (
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
              aria-label={level === 0 ? "Show two more weeks" : "Show all days"}
              title={level === 0 ? "Show two more weeks" : "Show all days"}
              className="flex shrink-0 items-center gap-1 self-stretch px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {level >= 1 ? <span>See all</span> : null}
              <ChevronRight className={cn("size-5", extending && "animate-pulse")} />
            </button>
          ) : null}
        </div>
        <TrayScrubber scrollerRef={scrollerRef} />
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

// A REAL scrollbar for the tray on touch screens, where the native one is an auto-hiding
// overlay you can't grab (iOS ignores the ::-webkit-scrollbar styling desktop uses). A
// slim track under the cards with a draggable thumb: drag it right and the strip scrolls
// toward older days — native scrollbar semantics, the mirror of swiping the cards
// themselves, and deliberately so (Rem, 2026-08-12). Tapping the track jumps there.
// Renders nothing when the days all fit, and nothing at all from sm up.
function TrayScrubber({
  scrollerRef,
}: {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Thumb geometry in % of the track, derived from the scroller's real proportions.
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const drag = useRef<{ startX: number; startLeft: number } | null>(null);
  // Overlay-scrollbar manners (Rem, 2026-08-12 — the always-on bar was intrusive): near
  // invisible at rest, brightening while the strip moves or a finger is on it, fading
  // back ~0.7s after the last movement. The hit area never fades — only the ink does.
  const [live, setLive] = useState(false);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poke = () => {
    setLive(true);
    if (fade.current) clearTimeout(fade.current);
    fade.current = setTimeout(() => {
      if (!drag.current) setLive(false);
    }, 700);
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 1) {
        setThumb(null);
        return;
      }
      // Floor the thumb at 16% so a long history still leaves something grabbable.
      const width = Math.max(16, (el.clientWidth / el.scrollWidth) * 100);
      const left = (el.scrollLeft / over) * (100 - width);
      setThumb({ left, width });
    };
    const onScroll = () => {
      update();
      poke();
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (fade.current) clearTimeout(fade.current);
    };
  }, [scrollerRef]);

  if (!thumb) return null;

  const down = (e: React.PointerEvent) => {
    const el = scrollerRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    const rect = track.getBoundingClientRect();
    const thumbPx = (thumb.width / 100) * rect.width;
    const usable = rect.width - thumbPx;
    const over = el.scrollWidth - el.clientWidth;
    const thumbLeft = (thumb.left / 100) * rect.width;
    const x = e.clientX - rect.left;
    let startLeft = el.scrollLeft;
    if (x < thumbLeft || x > thumbLeft + thumbPx) {
      // Tapped the track: centre the thumb under the finger, then drag from there.
      startLeft =
        usable > 0 ? Math.min(1, Math.max(0, (x - thumbPx / 2) / usable)) * over : 0;
      el.scrollLeft = startLeft;
    }
    drag.current = { startX: e.clientX, startLeft };
    poke();
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = scrollerRef.current;
    const track = trackRef.current;
    if (!d || !el || !track) return;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - (thumb.width / 100) * rect.width;
    if (usable <= 0) return;
    const over = el.scrollWidth - el.clientWidth;
    el.scrollLeft = d.startLeft + ((e.clientX - d.startX) / usable) * over;
  };
  const up = () => {
    drag.current = null;
    poke();
  };

  return (
    <div
      ref={trackRef}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      // h-3 is the touch target; the visible ink is the hairline thumb below.
      className="relative mx-1 h-3 touch-none select-none sm:hidden"
      aria-hidden
    >
      <div
        className={cn(
          "absolute top-1/2 h-1 -translate-y-1/2 rounded-full transition-colors duration-300",
          live ? "bg-white/35" : "bg-white/[0.09]",
        )}
        style={{ left: `${thumb.left}%`, width: `${thumb.width}%` }}
      />
    </div>
  );
}
