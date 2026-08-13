"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/** Phone-width probe, SSR-safe: the server snapshot says desktop, and the phone value
 *  lands right after hydration (useSyncExternalStore re-renders with the client
 *  snapshot — same pattern as the day strip's span ladder). */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(max-width: 639.98px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(max-width: 639.98px)").matches,
    () => false,
  );
}

/** Phone search MODE (Rem's spec, 2026-08-13). While `active`, #den-root carries
 *  `.den-searching` — den.css (under 640px) hides the app header + the home bands
 *  (greeting, action dock) and pins <main>'s height to `--lb-vvh` — and this hook keeps
 *  `--lb-vvh` tracking the visual viewport's true height through every keyboard
 *  movement, INCLUDING the interactive half-dismiss (finger holding the keyboard
 *  mid-swipe): iOS streams visualViewport resize/scroll events through the drag, each
 *  one coalesced to a frame here, so the content's bottom edge rides the keyboard's top
 *  edge and never shows more or less than fits. Shared by DenHome and the /kbtest
 *  fixture, so the Simulator exercises the real wiring. */
export function useSearchMode(active: boolean, keyboardUp: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.getElementById("den-root");
    if (!root) return;
    root.classList.add("den-searching");
    const vv = window.visualViewport;
    let raf = 0;
    const set = () => {
      raf = 0;
      root.style.setProperty("--lb-vvh", `${Math.round(vv?.height ?? window.innerHeight)}px`);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(set);
    };
    vv?.addEventListener("resize", on);
    vv?.addEventListener("scroll", on);
    set();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv?.removeEventListener("resize", on);
      vv?.removeEventListener("scroll", on);
      root.classList.remove("den-searching");
      root.style.removeProperty("--lb-vvh");
    };
  }, [active]);

  // The DISMISS expansion, driven, not observed: iOS reports the shrinking/growing
  // visual viewport in a couple of sparse events, so a box that only follows the events
  // both lags the dismissal and jumps in steps (Rem: "choppy... a little late"). The
  // moment the input blurs, the target height is already known — the full viewport — so
  // it is set immediately and den.css's height transition glides the box there in
  // parallel with the keyboard's own slide. The rise keeps following real events (the
  // final keyboard height isn't knowable up front); the same transition smooths those
  // steps too.
  useEffect(() => {
    if (!active || keyboardUp) return;
    const root = document.getElementById("den-root");
    root?.style.setProperty("--lb-vvh", `${Math.round(window.innerHeight)}px`);
  }, [active, keyboardUp]);

  // The reveal treatment for rows the expansion uncovers — without it they "just spawn
  // in" (Rem, 2026-08-13). Three variants, all in den.css, selected by a root class:
  // stagger (default — rows slot in one by one), fade (all together), curtain (no row
  // animation; the slowed height glide + edge fade do the unravel). `?reveal=fade` /
  // `?reveal=curtain` on the URL switches variant live, so comparing needs no rebuild.
  // A `den-reveal` pulse arms the animation for ~750ms on the two uncover moments —
  // entering the mode, and the keyboard leaving — and never while merely typing.
  useEffect(() => {
    const root = document.getElementById("den-root");
    if (!root) return;
    const v = new URLSearchParams(window.location.search).get("reveal");
    const variant = v === "fade" || v === "curtain" ? v : "stagger";
    root.classList.add(`den-reveal-${variant}`);
    return () => {
      root.classList.remove("den-reveal-stagger", "den-reveal-fade", "den-reveal-curtain");
    };
  }, []);
  const prevActive = useRef(false);
  const prevKb = useRef(false);
  useEffect(() => {
    const entered = active && !prevActive.current;
    const expanded = active && prevKb.current && !keyboardUp;
    prevActive.current = active;
    prevKb.current = keyboardUp;
    const root = document.getElementById("den-root");
    if (!root || (!entered && !expanded)) return;
    root.classList.add("den-reveal");
    const t = setTimeout(() => root.classList.remove("den-reveal"), 750);
    return () => {
      clearTimeout(t);
      root.classList.remove("den-reveal");
    };
  }, [active, keyboardUp]);
}
