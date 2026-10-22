"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Publishes the browser's UTC offset (minutes to ADD to UTC, e.g. +120 for UTC+2) to a
// cookie so server-rendered history queries can bucket plays by the user's *local* day
// instead of Turso's UTC. Spotify's API doesn't expose a user timezone, so the browser is
// the source of truth. Refreshes once when the value first appears or changes (e.g. travel
// / DST) so the day cards re-render correctly. Mounted in the (app) layout.
export function TimezoneCookie() {
  const router = useRouter();
  useEffect(() => {
    const offset = -new Date().getTimezoneOffset(); // JS gives minutes behind UTC; flip it
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith("tzoffset="))
      ?.slice("tzoffset=".length);
    if (current === String(offset)) return;
    document.cookie = `tzoffset=${offset}; path=/; max-age=31536000; samesite=lax`;
    router.refresh(); // re-render server components now that the offset is known
  }, [router]);
  return null;
}
