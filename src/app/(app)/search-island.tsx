"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SearchIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";

// A centered search "island" pinned to the bottom of the screen — brought back from the
// live app, restyled. It sits below the content (the page reserves room
// so it never overlaps the list/grid), which also signals you've reached the bottom.
// `children` is an optional trailing control tucked inside the pill (Home passes the
// songs/artists switch). On phones it owns the bottom edge (full-width, since thumbs
// don't hover), padded past the iOS home indicator.
//
// On a scrolling page it retreats DOWNWARD off-screen as you scroll down and returns as
// you scroll UP — direction-tracked (an accumulator over scroll deltas), not
// distance-from-top, so it comes back anywhere in the page, not only near the top (Rem,
// 2026-08-12: "it should show up as soon as you start scrolling up"). The travel is
// still driven 1:1 off the deltas, so it glides with the scroll instead of toggling.
// Home never scrolls on desktop, so scrollY stays 0 there and the island stays put.
//
// TOP_LOCK keeps it pinned within the first few px (no twitching at rest at the top);
// SLIDE is the scroll distance that walks it fully off / fully back.
const TOP_LOCK = 48;
const SLIDE = 200;

export function SearchIsland({
  query,
  onQuery,
  onFocus,
  placeholder,
  children,
}: {
  query: string;
  onQuery: (v: string) => void;
  /** Fired when the input takes focus — Home uses it to start fetching its search index
   *  before the first character is typed. */
  onFocus?: () => void;
  placeholder: string;
  children?: React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0); // 0 = docked, 1 = fully off-screen

  useEffect(() => {
    let raf = 0;
    let last = window.scrollY || document.documentElement.scrollTop || 0;
    const read = () => {
      raf = 0;
      const y = Math.max(0, window.scrollY || document.documentElement.scrollTop || 0);
      const dy = y - last;
      last = y;
      setProgress((p) => (y <= TOP_LOCK ? 0 : Math.min(1, Math.max(0, p + dy / SLIDE))));
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
  // The offset is read from the computed style (transform-independent) because it differs
  // per breakpoint now. Measured once on mount rather than read during render.
  const [travel, setTravel] = useState(92);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    const bottom = parseFloat(getComputedStyle(el).bottom) || 20;
    if (h) setTravel(h + bottom + 28); // + shadow slack
  }, []);

  // The phone keyboard. A bottom-anchored input under a rising keyboard proved unfixable
  // across browsers (Rem's recordings, 2026-08-13): Safari honours the layout's
  // interactive-widget=resizes-content hint and shrinks the page; Brave iOS ignores it and
  // just pans, leaving the pill behind the keys and the typing invisible; a JS
  // visualViewport lift double-applied wherever the hint DID work. So the pill stops
  // fighting the keyboard: while the input is FOCUSED on a phone it docks to the TOP of
  // the screen — the one edge no keyboard covers — over the header (z-50), and drops back
  // to the bottom on blur. Same element, CSS-only move, so focus never breaks. Desktop
  // never moves.
  const [focused, setFocused] = useState(false);
  // Blur drops the pill back down only after a beat: a tap on the pill's own trailing
  // control (Home's songs/artists switch) blurs the input first, and an instant
  // relocation would move the button out from under the finger before the tap lands.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusIn = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setFocused(true);
    // Cancel Safari's focus pan. iOS decides how far to scroll the page to "reveal" the
    // focused input around the moment the keyboard rises; even with the pill already
    // docked top, it can still pan to the input's previous bottom position (seen on the
    // iOS 26.5 Simulator, 2026-08-13) — which shoves the top of the page, pill included,
    // out of view. Repeatedly re-pinning scroll through the keyboard's rise window keeps
    // the page anchored; the loop is ~700ms of no-op rAF calls, then gone.
    if (window.matchMedia("(max-width: 639.98px)").matches) {
      const until = performance.now() + 700;
      const pin = () => {
        window.scrollTo(0, 0);
        if (performance.now() < until) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    }
  };
  const focusOut = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setFocused(false), 180);
  };
  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );
  const phone = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(max-width: 639.98px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(max-width: 639.98px)").matches,
    () => false,
  );
  const topDocked = focused && phone;

  return (
    <div
      ref={wrapRef}
      style={{
        // Top-docked: no hide-travel either — the scroll deltas Safari's focus pan fires
        // must not walk the pill around while someone is typing in it.
        transform: topDocked ? undefined : `translate3d(0, ${progress * travel}px, 0)`,
        willChange: "transform",
      }}
      className={cn(
        "pointer-events-none fixed inset-x-0 flex justify-center px-4",
        topDocked
          ? "top-2 z-50"
          : "bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 sm:bottom-5",
      )}
    >
      {/* h-10 to match the quick-action buttons exactly. Fixed (not padding-derived) so the
          pill is the same height on both pages — Home's trailing switch would otherwise make
          it taller than the Playlists one. Phones: full width (minus the page gutter), since
          a fixed-width input would overflow a 390px screen once the trailing switch is in —
          and h-12 there: at the phone's 85% scale h-10 landed a too-thin ~34px bar. */}
      <div className="pointer-events-auto flex h-12 w-full items-center gap-2 rounded-full border border-border bg-popover/95 pl-4 pr-1.5 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur sm:h-10 sm:w-auto">
        {/* Full-strength ink: the one thing in the pill that should read at a glance as
            "this is the search". Everything else stays muted. */}
        <SearchIcon className="size-4 shrink-0 text-foreground" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          // NOT docked on pointerdown: moving the input out from under the finger before
          // touchend makes iOS drop the click, so focus never lands and the keyboard
          // never rises (iOS 26.5 Simulator, 2026-08-13). The dock happens at focus; the
          // scroll-pin loop in focusIn is what cancels Safari's pan to the old spot.
          onFocus={() => {
            focusIn();
            onFocus?.();
          }}
          onBlur={focusOut}
          placeholder={placeholder}
          aria-label={placeholder}
          // 16px on the phone, non-negotiable: iOS ZOOMS the whole page when a focused
          // input's font-size is under 16px, and that zoom is what kept throwing the pill
          // out of view no matter where it was docked (Rem, 2026-08-13 — "based on how the
          // zoom works"). At the phone's 85% root scale text-sm is ~12px, so this must be
          // a raw px size, not a rem class.
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/70 sm:w-[15.25rem] sm:flex-none sm:text-sm"
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
