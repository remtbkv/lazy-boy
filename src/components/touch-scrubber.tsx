"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// A REAL scrollbar for horizontal strips on touch screens, where the native one is an
// auto-hiding overlay you can't grab (iOS ignores the ::-webkit-scrollbar styling desktop
// uses — and den.css hides those under 640px anyway). A hairline thumb tucked right under
// the strip: drag it right and the strip scrolls right — native scrollbar semantics, the
// mirror of swiping the content, and deliberately so (Rem, 2026-08-12). Tapping the
// hit-strip jumps there. Overlay-scrollbar manners: near invisible at rest, brightening
// while the strip moves or a finger is on it, fading ~0.7s after the last movement — the
// hit area never fades, only the ink. Renders nothing when the content fits, and nothing
// at all from sm up.
export function TouchScrubber({
  scrollerRef,
  className,
}: {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Thumb geometry in % of the track, derived from the scroller's real proportions.
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const drag = useRef<{ startX: number; startLeft: number } | null>(null);
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
      // Floor the thumb at 16% so a long strip still leaves something grabbable.
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
      // h-2 is the touch target, sitting right under the strip; the visible ink is the
      // 3px hairline thumb.
      className={cn("relative h-2 touch-none select-none sm:hidden", className)}
      aria-hidden
    >
      <div
        className={cn(
          "absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-colors duration-300",
          live ? "bg-white/35" : "bg-white/[0.09]",
        )}
        style={{ left: `${thumb.left}%`, width: `${thumb.width}%` }}
      />
    </div>
  );
}
