"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const STALE_MS = 15 * 60 * 1000; // re-sync the library at most every 15 min
const COOLDOWN_MS = 60 * 1000; // after any attempt, don't re-fire for a while
const REFRESH_EVERY_MS = 4000; // pull newly-cached data into the view this often, mid-sync

// App-wide guards (module scope) so navigating between pages — each of which mounts this —
// never spawns overlapping syncs or retries in a tight loop while rate-limited.
let inFlight = false;
let lastAttempt = 0;

// Fire-and-forget: if the stored library is empty or stale, kick a single background sync
// task and poll it for progress, refreshing the view periodically so newly-cached
// playlists/tracks appear as they land — never blocking navigation. The scan itself runs
// server-side (paced, snapshot-gated, committing per playlist), so it finishes even if you
// navigate away; this component just surfaces progress and integrates the results.
export function PlaylistsSync({ syncedAt }: { syncedAt: string | null }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  // `shown` is the displayed number; it eases toward `percent` (the real progress, which
  // arrives in chunky 1.5s polls) so it counts up smoothly instead of jumping 14 → 30 → 100.
  const [shown, setShown] = useState(0);
  const percentRef = useRef<number | null>(null);
  useEffect(() => {
    percentRef.current = percent;
  }, [percent]);

  // Tween the displayed percent toward the latest target while a sync is running. Step is
  // proportional, so it catches up fast when far behind and settles gently near the target.
  useEffect(() => {
    if (!syncing) return;
    const id = setInterval(() => {
      setShown((s) => {
        const target = percentRef.current ?? s;
        if (s >= target) return s;
        return Math.min(target, s + Math.max(1, Math.ceil((target - s) / 6)));
      });
    }, 60);
    return () => clearInterval(id);
  }, [syncing]);

  useEffect(() => {
    const stale = !syncedAt || Date.now() - new Date(syncedAt).getTime() > STALE_MS;
    if (!stale) return;
    if (inFlight) return;
    if (Date.now() - lastAttempt < COOLDOWN_MS) return;

    inFlight = true;
    lastAttempt = Date.now();
    let mounted = true;
    let pollId: ReturnType<typeof setInterval> | undefined;
    let lastRefresh = Date.now();

    // Reflect the background sync we're firing right here (legitimate "pending UI while an
    // external op runs" case — one extra render on mount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSyncing(true);
    setShown(0); // restart the counter for this run

    const stop = (refresh: boolean) => {
      if (pollId) clearInterval(pollId);
      inFlight = false;
      if (!mounted) return;
      setSyncing(false);
      setPercent(null);
      if (refresh) router.refresh();
    };

    fetch("/api/playlists/sync", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        // Unmounted while the kickoff was in flight — don't create an interval nobody
        // can clear (cleanup already ran with pollId still undefined).
        if (!mounted) return;
        if (!d.ok || !d.taskId) {
          stop(false);
          return;
        }
        pollId = setInterval(async () => {
          try {
            const res = await fetch(`/api/tasks/${d.taskId}`, { cache: "no-store" });
            // 404 = the task is gone for good (registry sweep, server restart, other
            // serverless instance) — stop, or this polls every 1.5s forever with the
            // "syncing…" label stuck.
            if (res.status === 404) {
              stop(true);
              return;
            }
            if (!res.ok) return;
            const task = (await res.json()) as {
              status: string;
              processed: number;
              total: number;
            };
            if (mounted && task.total > 0) {
              setPercent(Math.min(99, Math.round((task.processed / task.total) * 100)));
            }
            // Integrate incremental progress into the view, throttled.
            if (Date.now() - lastRefresh > REFRESH_EVERY_MS) {
              lastRefresh = Date.now();
              if (mounted) router.refresh();
            }
            if (task.status === "done" || task.status === "error") stop(true);
          } catch {
            /* transient poll hiccup — keep going */
          }
        }, 1500);
      })
      .catch(() => stop(false));

    return () => {
      mounted = false;
      if (pollId) clearInterval(pollId);
      inFlight = false;
      // A dep-change re-run (fresh syncedAt arriving mid-poll) returns early at the
      // staleness check — reset here so "syncing…" can't stick with no poller alive.
      setSyncing(false);
      setPercent(null);
    };
  }, [syncedAt, router]);

  if (!syncing) return null;
  return (
    <span className="text-xs text-muted-foreground/70" aria-live="polite">
      syncing{shown > 0 ? ` ${shown}%` : "…"}
    </span>
  );
}
