"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Publishes the browser's UTC offset (minutes to ADD to UTC, e.g. +120 for UTC+2) and its IANA
// zone (`America/Chicago`) to two cookies, so server-rendered history queries can bucket plays
// by the user's *local* day instead of Turso's UTC, and /api/sync can store the zone the Home
// payload buckets in on the write path (multi-user PLAN §4.3, design C §3.3). Spotify's API
// doesn't expose a user timezone, so the browser is the source of truth. Refreshes once when
// either value first appears or changes (e.g. travel / DST) so the day cards re-render
// correctly. Mounted in the (app) layout.
export function TimezoneCookie() {
  const router = useRouter();
  useEffect(() => {
    const offset = String(-new Date().getTimezoneOffset()); // JS gives minutes behind UTC; flip it
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const jar = new Map(document.cookie.split("; ").map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));
    if (jar.get("tzoffset") === offset && jar.get("tzname") === zone) return;
    document.cookie = `tzoffset=${offset}; path=/; max-age=31536000; samesite=lax`;
    // IANA names are letters, digits, `/`, `_`, `+` and `-`: cookie-safe as they are.
    document.cookie = `tzname=${zone}; path=/; max-age=31536000; samesite=lax`;
    router.refresh(); // re-render server components now that the offset is known
  }, [router]);
  return null;
}
