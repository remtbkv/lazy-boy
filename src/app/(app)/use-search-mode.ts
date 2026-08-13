"use client";

import { useEffect, useSyncExternalStore } from "react";

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
export function useSearchMode(active: boolean): void {
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
}
