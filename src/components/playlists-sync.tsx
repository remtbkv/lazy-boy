"use client";

import { useEffect } from "react";

const STALE_MS = 15 * 60 * 1000; // re-sync the library at most every 15 min
const COOLDOWN_MS = 60 * 1000; // after any attempt, don't re-fire for a while

// App-wide guards (module scope) so navigating between pages — each of which mounts this —
// never spawns overlapping kickoffs in a tight loop.
let inFlight = false;
let lastAttempt = 0;

// Headless: when the cached library is stale, kick a single background scan and get out of the
// way. The scan runs server-side to completion (paced, snapshot-gated, committing per playlist)
// whether or not anything stays mounted, so there's nothing to poll and nothing to display —
// newly-cached playlists surface on the next navigation. No on-page indicator and no periodic
// router.refresh, so the home view never shifts or flashes while a sync runs in the background.
export function PlaylistsSync({ syncedAt }: { syncedAt: string | null }) {
  useEffect(() => {
    const stale = !syncedAt || Date.now() - new Date(syncedAt).getTime() > STALE_MS;
    if (!stale || inFlight || Date.now() - lastAttempt < COOLDOWN_MS) return;
    inFlight = true;
    lastAttempt = Date.now();
    fetch("/api/playlists/sync", { method: "POST" })
      .catch(() => {
        /* offline / kickoff failed — a later mount retries past the cooldown */
      })
      .finally(() => {
        inFlight = false;
      });
  }, [syncedAt]);

  return null;
}
