"use client";

import { useEffect, useRef, useState } from "react";
import { SearchIcon, X } from "lucide-react";

// A centered search "island" pinned to the bottom of the screen — brought back from the
// live app, restyled. It sits below the content (the page reserves room
// so it never overlaps the list/grid), which also signals you've reached the bottom.
// `children` is an optional trailing control tucked inside the pill (Home passes the
// songs/artists switch). Desktop layout for now; mobile is refined later.
//
// On a scrolling page it retreats DOWNWARD off-screen as you leave the top — the mirror of a
// sticky header sliding up. The travel is driven straight off scrollY (not a binary toggle),
// so it tracks the scroll 1:1 and comes back as you approach the top again. Home never
// scrolls, so scrollY stays 0 there and the island simply stays put.
//
// HIDE_START gives it a dead-zone: a nudge of the wheel shouldn't make it twitch. Past that it
// glides away over HIDE_END-HIDE_START px, which is a long enough runway to read as deliberate
// rather than snapping off-screen.
const HIDE_START = 48;
const HIDE_END = 360;

export function SearchIsland({
  query,
  onQuery,
  placeholder,
  children,
}: {
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  children?: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0); // 0 = docked, 1 = fully off-screen

  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const p = (y - HIDE_START) / (HIDE_END - HIDE_START);
      setProgress(Math.min(1, Math.max(0, p)));
    };
    const onScroll = () => {
      // Coalesce to one read per frame so the transform lands with the paint — this is what
      // keeps it glued to the scroll instead of lagging behind it.
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // Travel = the pill's own height + its bottom offset + a little slack for the shadow, so
  // at progress 1 nothing (not even the glow) is left peeking above the viewport edge.
  // Measured once on mount rather than read during render.
  const [travel, setTravel] = useState(92);
  useEffect(() => {
    const h = wrapRef.current?.getBoundingClientRect().height;
    if (h) setTravel(h + 20 + 28); // + bottom offset (bottom-5) + shadow slack
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{
        transform: `translate3d(0, ${progress * travel}px, 0)`,
        willChange: "transform",
      }}
      className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4"
    >
      {/* h-10 to match the quick-action buttons exactly. Fixed (not padding-derived) so the
          pill is the same height on both pages — Home's trailing switch would otherwise make
          it taller than the Playlists one. */}
      <div className="pointer-events-auto flex h-10 items-center gap-2 rounded-full border border-border bg-popover/95 pl-4 pr-1.5 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur">
        {/* Full-strength ink: the one thing in the pill that should read at a glance as
            "this is the search". Everything else stays muted. */}
        <SearchIcon className="size-4 shrink-0 text-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-[15.25rem] min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQuery("")}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}
