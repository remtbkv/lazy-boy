"use client";

import { useEffect, useRef } from "react";

// Pressing the tab you are already on clears that page's search (Rem, 2026-08-22: "when I
// press home as well, it should clear whatever I had on the search"). A <Link> to the route
// you are already on is a no-op — same URL, same mounted tree — so nothing in the page's state
// moves on its own. This is the signal that moves it.
//
// An event rather than context or a URL param, for two reasons: the chrome lives in the layout
// and must not know which page rendered it (chrome.tsx), and putting the query in the URL would
// make every keystroke a history entry.
//
// The bus is a module-level EventTarget rather than `window`: one instance across the client
// bundle (the chrome is in the layout, the pages are not), nothing added to a shared global,
// and it works in the test environment, where `globalThis` is not an EventTarget.
const BUS = new EventTarget();
const EVENT = "lb:tab-reset";

/** Fired by the chrome when a nav target is the route already showing. */
export function announceTabReset(tab: string): void {
  BUS.dispatchEvent(new CustomEvent(EVENT, { detail: tab }));
}

/** Listen for a reset of one tab. Returns the unsubscribe. */
export function subscribeTabReset(tab: string, reset: () => void): () => void {
  const on = (e: Event) => {
    if ((e as CustomEvent<string>).detail === tab) reset();
  };
  BUS.addEventListener(EVENT, on);
  return () => BUS.removeEventListener(EVENT, on);
}

/** Clear this page's transient view state when its own tab is pressed again. The callback is
 *  held in a ref so the listener attaches once — Home re-renders on every keystroke, and
 *  re-subscribing per render would churn a listener under the typing. */
export function useTabReset(tab: string, reset: () => void): void {
  const latest = useRef(reset);
  useEffect(() => {
    latest.current = reset;
  }, [reset]);
  useEffect(() => subscribeTabReset(tab, () => latest.current()), [tab]);
}
