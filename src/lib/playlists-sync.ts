// Background full-library sync → persistent SQLite store. Pages read from the store
// (instant, no Spotify call on render); this fills it in the background, paced so it never
// trips Spotify's shared 429 cooldown (which would freeze now-playing/navigation).
//
// It runs as a task (returns a task id immediately, never blocks the request), commits
// each playlist's tracks as it fetches them (checkpoints), and is snapshot-gated — so it
// skips unchanged playlists, is cheap in steady state, and an interrupted run just picks
// up the rest next time. The client polls the task for progress and refreshes periodically
// so newly-cached data appears as it lands.
import "server-only";
import { auth, getValidAccessToken } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { syncLibrary } from "@/lib/sync/library";
import { getTask, runTask, type Task } from "@/lib/tasks/registry";

// Gentle pacing between playlist-track fetches keeps the burst under Spotify's rate limit.
const SYNC_PACE_MS = 150;

// One sync at a time. Overlapping triggers (one per page as you navigate) collapse onto
// the running task instead of each kicking off a fresh scan.
let currentSyncId: string | null = null;

export async function startLibrarySync(): Promise<{ taskId: string }> {
  const session = await auth();
  if (!session?.accessToken || session.error) throw new Error("unauthorized");

  if (currentSyncId) {
    const t = getTask(currentSyncId);
    if (t && (t.status === "running" || t.status === "queued")) {
      return { taskId: currentSyncId };
    }
  }

  // Patient client: a background sync should ride out Spotify's rate-limit cooldowns and
  // finish, not fail fast like an interactive call. Combined with pacing, it stays gentle.
  // Token getter, not the session's fixed token — a cold full-library scan can outlive
  // the ~1h access token (GOTCHAS: background tasks get a getter, or they 401 mid-run).
  const sp = spotifyClient(async () => {
    const t = await getValidAccessToken();
    if (!t) throw new Error("Spotify session expired — log out and back in.");
    return t;
  }, true);
  const task: Task = runTask("library-sync", (onProgress) =>
    syncLibrary(sp, onProgress, { paceMs: SYNC_PACE_MS }),
  );
  currentSyncId = task.id;
  return { taskId: task.id };
}
