"use client";

import { useEffect } from "react";
import { clearIfSignedOut } from "@/lib/user-storage";
import { useUid } from "@/components/user-context";
import { SyncLoop } from "@/lib/budget/sync-interval";

// Keeps listen-history current automatically: pings POST /api/sync once when
// the app loads, then every 2 minutes while the tab is visible, and again whenever the
// tab regains focus — so opening (or returning to) the site shows plays right up to the
// moment. 2 min comfortably beats a song's length, so an open tab stays effectively
// live. The server (/api/sync) decides whether a sync is actually due, so multiple tabs
// and quick navigations collapse to one Spotify call. Times the app is closed are
// covered by the Zenbook's 2-min timer on /api/cron/sync. Mounted once in the (app) layout.
// The 2 minutes is the budget's normal mode: each reply carries the interval, 5 minutes in
// economy and freeze, and SyncLoop (lib/budget/sync-interval.ts) follows it.
export function SyncOnLoad() {
  const uid = useUid();
  useEffect(() => {
    const loop = new SyncLoop(
      async () => {
        const res = await fetch("/api/sync", { method: "POST" });
        clearIfSignedOut(res, uid);
        return res.ok ? res.json() : null;
      },
      () => document.visibilityState === "visible",
    );
    loop.start(); // immediate, so a fresh open catches up right away
    const onVisibility = () => loop.focus();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      loop.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [uid]);
  return null;
}
