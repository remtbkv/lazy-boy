"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Task } from "@/lib/tasks/registry";

// The 2-minute cron tick owns library freshness — it re-scans whenever the store is more than
// 30 min old, without a session and whether or not the app is open. So this client kick is a
// fallback for the case where that tick has stopped running, not the normal refresh path, and
// its window sits far past the cron's own. An empty store still kicks immediately: there is
// nothing to show and no reason to wait for the next tick.
const STALE_MS = 2 * 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000; // after any attempt, don't re-fire for a while
const POLL_MS = 2000; // cold start only: how often we check the scan's progress
const WATCH_MAX_MS = 10 * 60 * 1000; // and how long we're willing to watch one

// App-wide guards (module scope) so navigating between pages — each of which mounts this —
// never spawns overlapping kickoffs in a tight loop.
let inFlight = false;
let lastAttempt = 0;
let watching = false;

// Cold-start watcher: poll the scan and refresh the view as its results land. Module scope,
// not an effect: the first refresh changes `syncedAt`, which re-runs the effect below — an
// effect-scoped poll would cancel itself on the very refresh it just fired. It ends on the
// task's terminal state (or the deadline), so nothing is left spinning.
async function watchColdStart(taskId: string, refresh: () => void): Promise<void> {
  if (watching) return;
  watching = true;
  const deadline = Date.now() + WATCH_MAX_MS;
  let filled = false;
  let blindRefreshes = 0;
  try {
    while (Date.now() < deadline) {
      const res = await fetch(`/api/tasks/${taskId}`).catch(() => null);
      if (!res?.ok) {
        // The task registry is per-instance on serverless, so a poll routed to another
        // instance 404s even while the scan is running fine. Bailing on the first miss
        // left the cold-start grid empty for the whole scan (audit 2026-08-19, T2.10) —
        // instead, refresh on a slow cadence so the grid fills as playlists commit.
        // Capped: a permanently-dead task must not drive router.refresh() for the whole
        // 10-min watch window (wave-2 adversarial review, finding L).
        if (++blindRefreshes > 6) return;
        refresh();
        await new Promise((r) => setTimeout(r, POLL_MS * 5));
        continue;
      }
      const task = (await res.json()) as Task;
      // `total` is only set once the playlist list has been stored, which is what the grid
      // renders — so this is the moment the empty grid can fill, long before the scan ends.
      if (!filled && task.total > 0) {
        filled = true;
        refresh();
      }
      if (task.status === "done") {
        refresh(); // the counts settle here (unique songs is recomputed at the end)
        return;
      }
      if (task.status === "error") return;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    watching = false;
  }
}

// Headless: when the cached library is stale, kick a single background scan and get out of the
// way. The scan runs server-side to completion (paced, snapshot-gated, committing per playlist)
// whether or not anything stays mounted, so the page never waits on it — newly-cached playlists
// surface on the next navigation. No on-page indicator and no periodic router.refresh, so the
// view never shifts or flashes while a sync runs in the background.
//
// The one exception is a cold start (nothing stored yet): the page is rendering an empty grid,
// so leaving it blank for the length of a full scan is the wrong call. There, and only there,
// we watch the scan and refresh as it lands — with nothing on screen, there is nothing to shift.
export function PlaylistsSync({ syncedAt }: { syncedAt: string | null }) {
  const router = useRouter();

  useEffect(() => {
    const stale = !syncedAt || Date.now() - new Date(syncedAt).getTime() > STALE_MS;
    if (!stale || inFlight || Date.now() - lastAttempt < COOLDOWN_MS) return;
    const coldStart = !syncedAt;
    inFlight = true;
    lastAttempt = Date.now();
    fetch("/api/playlists/sync", { method: "POST" })
      .then(async (res) => {
        if (!coldStart || !res.ok) return;
        const { taskId } = (await res.json()) as { taskId?: string };
        if (taskId) void watchColdStart(taskId, () => router.refresh());
      })
      .catch(() => {
        /* offline / kickoff failed — a later mount retries past the cooldown */
      })
      .finally(() => {
        inFlight = false;
      });
  }, [syncedAt, router]);

  return null;
}
