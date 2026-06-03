"use client";

import { useEffect, useRef } from "react";
import { SearchIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const GAP = 16; // desired space between the last row and the pill (matches grid gap)

// Minimal centered pill pinned to the bottom of the viewport: a search field plus
// an optional action (see more / see less). Shared by the playlists grid and the
// listening-history table so both behave identically. Fixed at the bottom — the
// now-playing UI lives in the header, so nothing pushes this around.
//
// Robust clearance: rather than a hard-coded bottom padding (which can't account for
// the pill's varying height — the "see more" action makes it taller — or per-page
// layout slack), the pill measures itself and its parent at runtime and sets exactly
// the padding needed to leave one grid gap above it when scrolled to the end. Any
// page that renders <FloatingBar> as a child of its scroll-content container gets
// this for free.
export function FloatingBar({
  query,
  onQuery,
  placeholder,
  action,
}: {
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  action?: { label: string; onClick: () => void } | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const container = wrap?.parentElement as HTMLElement | null;
    if (!wrap || !container) return;

    let raf = 0;
    const apply = () => {
      // Measure from the last real content element (the pill's previous sibling),
      // not the container box: the pill is fixed but still a flow sibling, so it can
      // inject phantom space (e.g. a space-y margin) into the container's height.
      const last = wrap.previousElementSibling as HTMLElement | null;
      if (!last) return;
      // The pill is fixed, so its viewport position is scroll-independent.
      const pillTopFromBottom = window.innerHeight - wrap.getBoundingClientRect().top;
      const current = Math.round(parseFloat(container.style.paddingBottom || "0"));
      // Space below the last content down to the document end, minus the padding we
      // control — i.e. everything else (phantom margins, main padding). Invariant to
      // `current`, so reading it live is safe.
      const lastBottomDoc = last.getBoundingClientRect().bottom + window.scrollY;
      const belowContent =
        document.documentElement.scrollHeight - lastBottomDoc - current;
      const needed = Math.max(0, Math.round(pillTopFromBottom + GAP - belowContent));
      if (current !== needed) container.style.paddingBottom = `${needed}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };

    schedule();
    // Recompute when the pill resizes (action button toggles its height) or content
    // reflows. The guard above makes the resulting observer callback a no-op once
    // stable, so this can't loop.
    const ro = new ResizeObserver(schedule);
    ro.observe(wrap);
    ro.observe(container);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      container.style.paddingBottom = "";
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-popover py-2 pl-4 pr-2 shadow-2xl shadow-black/50 ring-1 ring-white/5">
        <SearchIcon className="size-4 shrink-0 text-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          className="w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground sm:w-64"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQuery("")}
            className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : action ? (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full text-muted-foreground hover:text-foreground"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
