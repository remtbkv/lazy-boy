"use client";

import { useRef, useState, type ReactNode } from "react";

// One-line text that clips to its container, then slides to reveal the rest while
// the pointer is over it (sliding back on leave). No-op when the text fits. Shared
// by the history table and the now-playing chip so the motion is consistent.
export function HoverScroll({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  const onEnter = () => {
    const o = outerRef.current;
    const i = innerRef.current;
    if (!o || !i) return;
    const over = i.scrollWidth - o.clientWidth;
    setShift(over > 2 ? over : 0);
  };

  // Constant ~35px/s so long and short overflow feel the same — gentle, readable.
  const duration = Math.max(0.5, shift / 35);
  return (
    <span
      ref={outerRef}
      onMouseEnter={onEnter}
      onMouseLeave={() => setShift(0)}
      className={`block select-text overflow-hidden whitespace-nowrap ${className}`}
    >
      <span
        ref={innerRef}
        className="inline-block align-bottom will-change-transform"
        style={{
          transform: `translateX(-${shift}px)`,
          transition: `transform ${duration}s linear`,
        }}
      >
        {children}
      </span>
    </span>
  );
}
