"use client";

import { useEffect } from "react";
import { clearIfSignedOut } from "@/lib/user-storage";
import { useUid } from "@/components/user-context";
import { SyncLoop } from "@/lib/budget/sync-interval";

// Keeps listen-history current automatically: pings POST /api/sync once when the app loads,
// again whenever the tab regains focus, and every 2 minutes while the tab is visible. The load
// and the return carry `x-sync: load`: the server then probes the player and harvests a track
// change it has not stored yet, so opening (or returning to) the site shows plays right up to
// the moment. The 2-minute timer carries `x-sync: timer` and does nothing while the cron's ticks
// run; it stands in for them only when none has run in 5 minutes (/api/sync, multi-user PLAN
// §7.6). Times the app is closed are the cron's (/api/cron/sync). Mounted once in the (app)
// layout. The 2 minutes is the budget's normal mode: each reply carries the interval, 5 minutes
// in economy and freeze, and SyncLoop (lib/budget/sync-interval.ts) follows it.
export function SyncOnLoad() {
  const uid = useUid();
  useEffect(() => {
    const loop = new SyncLoop(
      async (kind) => {
        const res = await fetch("/api/sync", { method: "POST", headers: { "x-sync": kind } });
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
