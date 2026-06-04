"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A small styled tooltip matching the app's popover look, so labels (exact
// timestamps, brief "what does this do" hints) read cleanly instead of through the
// browser's harsh native `title`. Portaled to <body> and fixed-positioned, so a
// scroll container can't clip it.
//
// Defaults keep it instant + single-line (the history timestamp use); pass `delay`
// for a considered hover and `tipClassName` for a wider, wrapping info box.
export function HoverTip({
  label,
  children,
  className,
  delay = 0,
  placement = "top",
  tipClassName,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  delay?: number;
  placement?: "top" | "bottom";
  tipClassName?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once the wrapped control is clicked, suppress the tip until the pointer leaves —
  // an info hint shouldn't hang around over the thing you just acted on.
  const suppressed = useRef(false);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  function show() {
    if (suppressed.current) return;
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = r.left + r.width / 2;
    const y = placement === "top" ? r.top - 8 : r.bottom + 8;
    timer.current = setTimeout(() => setTip({ x, y }), delay);
  }
  function hide() {
    if (timer.current) clearTimeout(timer.current);
    setTip(null);
  }
  function onLeave() {
    suppressed.current = false; // re-arm for the next deliberate hover
    hide();
  }
  function onDown() {
    suppressed.current = true; // a click means "I've decided" — drop the hint
    hide();
  }

  const look =
    tipClassName ??
    "whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-lg ring-1 ring-white/5";

  return (
    <span
      ref={ref}
      className={className}
      onMouseEnter={show}
      onMouseLeave={onLeave}
      onPointerDown={onDown}
    >
      {children}
      {tip
        ? createPortal(
            <span
              role="tooltip"
              style={{ left: tip.x, top: tip.y }}
              className={`pointer-events-none fixed z-[60] -translate-x-1/2 ${
                placement === "top" ? "-translate-y-full" : ""
              } ${look}`}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
