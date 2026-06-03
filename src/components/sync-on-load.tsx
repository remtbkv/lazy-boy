"use client";

import { useEffect } from "react";

// Pings /api/sync when the app is open so listen-history stays current during use
// (the server decides whether a sync is actually due). Replaces the old in-process
// setInterval scheduler, which serverless can't run. Module-scoped cooldown so
// navigating between pages — each mounts this via the layout — doesn't re-fire.
let lastPing = 0;
const COOLDOWN_MS = 60 * 1000;

export function SyncOnLoad() {
  useEffect(() => {
    if (Date.now() - lastPing < COOLDOWN_MS) return;
    lastPing = Date.now();
    fetch("/api/sync", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}
