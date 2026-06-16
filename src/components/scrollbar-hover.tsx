"use client";

import { useEffect } from "react";

// Reveal the thin scrollbar whenever the pointer is anywhere inside a scrollable area
// (any `.thin-scroll`), and hide it on leave — consistently across every scroll area
// (day strip, history table, playlist track list, menus, …).
//
// Done by toggling a class via pointer delegation rather than the CSS `:hover` on the
// scroll container: Chrome repaints `::-webkit-scrollbar` pseudo-elements inconsistently
// for content hover, so `:hover` only lit the bar up when the pointer neared it. A real
// class change forces the repaint, so hovering any part of the area shows the bar.
//
// SHOW_DELAY: the pointer must dwell briefly before the bar appears, so sweeping the cursor
// across a scrollable doesn't flash it. HIDE_DELAY: it lingers after you leave, so it eases
// out (with the CSS fade) instead of snapping off / flickering between adjacent areas.
const SHOW_DELAY = 120;
const HIDE_DELAY = 320;

export function ScrollbarHover() {
  useEffect(() => {
    let current: Element | null = null; // currently shown
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const clearActive = () => {
      if (current) current.classList.remove("thin-scroll-active");
      current = null;
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.(".thin-scroll") ?? null;
      if (el) {
        clearTimeout(hideTimer); // entering something — cancel any pending hide
        if (el === current) {
          clearTimeout(showTimer); // already shown and still inside
          return;
        }
        clearTimeout(showTimer);
        showTimer = setTimeout(() => {
          if (current && current !== el) current.classList.remove("thin-scroll-active");
          el.classList.add("thin-scroll-active");
          current = el;
        }, SHOW_DELAY);
      } else {
        // left every scrollable — cancel a not-yet-shown reveal, and fade the shown one out
        // after a short linger.
        clearTimeout(showTimer);
        if (current) {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(clearActive, HIDE_DELAY);
        }
      }
    };

    document.addEventListener("mouseover", onOver);
    return () => {
      document.removeEventListener("mouseover", onOver);
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      clearActive();
    };
  }, []);
  return null;
}
