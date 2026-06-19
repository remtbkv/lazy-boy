"use client";

import { useEffect, useRef, useState } from "react";

// Tweens from the previously shown value to a new one (ease-out) instead of snapping, so a
// count that ticks up — e.g. plays or listened-time on a background refresh — rolls smoothly.
// First paint shows the value as-is (no intro count-up); only later changes animate. Honors
// prefers-reduced-motion. `format` turns the in-flight number into the displayed string
// (default: locale integer; pass formatListenTime for durations).
export function AnimatedNumber({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  duration = 600,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(value);
  // Latest shown value, written only in effects/callbacks (never during render) so a tween
  // already in flight is the starting point for the next one — no jump on a mid-tween change.
  const shown = useRef(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const from = shown.current;
    if (from === value) return; // unchanged (also the first-mount case) — leave it as-is
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      shown.current = value;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (value - from) * eased;
      shown.current = v;
      setDisplay(v);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, duration]);

  return <>{format(display)}</>;
}
