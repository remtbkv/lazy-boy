"use client";

import { useEffect } from "react";
import { clearIfSignedOut } from "@/lib/user-storage";
import { useUid } from "@/components/user-context";

// Keeps listen-history current automatically: pings POST /api/sync once when the app loads,
// again whenever the tab regains focus, and every 2 minutes while the tab is visible. The load
// and the return carry `x-sync: load`: the server then probes the player and harvests a track
// change it has not stored yet, so opening (or returning to) the site shows plays right up to
// the moment. The 2-minute timer carries `x-sync: timer` and does nothing while the cron's ticks
// run; it stands in for them only when none has run in 5 minutes (/api/sync, multi-user PLAN
// §7.6). Times the app is closed are the cron's (/api/cron/sync). Mounted once in the (app)
// layout.
const POLL_MS = 2 * 60 * 1000;

export function SyncOnLoad() {
  const uid = useUid();
  useEffect(() => {
    const sync = (kind: "load" | "timer") => {
      if (document.visibilityState === "visible") {
        fetch("/api/sync", { method: "POST", headers: { "x-sync": kind } }).then((r) => clearIfSignedOut(r, uid), () => {});
      }
    };
    const onVisible = () => sync("load");
    sync("load"); // immediate, so a fresh open catches up right away
    const id = setInterval(() => sync("timer"), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [uid]);
  return null;
}
