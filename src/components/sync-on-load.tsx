"use client";

import { useEffect } from "react";

// Keeps listen-history current without a sync button: pings POST /api/sync once when
// the app loads, then every 2 minutes while the tab is visible, and again whenever the
// tab regains focus — so opening (or returning to) the site shows plays right up to the
// moment. 2 min comfortably beats a song's length, so an open tab stays effectively
// live. The server (/api/sync) decides whether a sync is actually due, so multiple tabs
// and quick navigations collapse to one Spotify call. Times the app is closed are
// covered by the GitHub Actions cron. Mounted once in the (app) layout.
const POLL_MS = 2 * 60 * 1000;

export function SyncOnLoad() {
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === "visible") {
        fetch("/api/sync", { method: "POST" }).catch(() => {});
      }
    };
    sync(); // immediate, so a fresh open catches up right away
    const id = setInterval(sync, POLL_MS);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return null;
}
