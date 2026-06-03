import "server-only";
import { getValidAccessToken } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { getLastSync } from "@/lib/db";
import { syncRecentPlays } from "@/lib/sync/history";

// How often to pull recent plays in the background — every minute, so a finished
// song shows up soon after. Single knob; can be raised later if it proves too eager.
// (The history page also refreshes itself every minute while its tab is open.)
const INTERVAL_MS = 60 * 1000;

// REMOVE LATER (added 2026-06-03): coarse 4-hour failsafe sync, independent of the
// 1-minute scheduler above. The 1-min sync silently stopped advancing for ~20h
// (last_sync stuck while new plays piled up), so this is a belt-and-suspenders
// backstop that runs regardless of playback "just in case there's a bug". Once the
// 1-min path is proven reliable, delete this constant and the failsafe timer below.
const FAILSAFE_MS = 4 * 60 * 60 * 1000;

const g = globalThis as unknown as {
  __syncTimers?: { main: ReturnType<typeof setInterval>; failsafe: ReturnType<typeof setInterval> };
};

async function runOnce(reason: string) {
  try {
    // No signed-in user (or a dead refresh token) → nothing to sync, stay quiet.
    const token = await getValidAccessToken();
    if (!token) return;
    const { added } = await syncRecentPlays(spotifyClient(token));
    console.log(`[sync] ${reason}: ${added} new play(s)`);
  } catch (e) {
    // Never let a transient failure (network, 429) crash the loop.
    console.error("[sync] failed:", e instanceof Error ? e.message : e);
  }
}

// Start the recurring history sync. Re-arms on every call: a Next dev server
// reload (HMR) can tear down the module context that owns the interval while the
// old guard flag survives on globalThis, silently orphaning the timer — which is
// how sync stopped advancing for ~20h. Clearing any existing timers and recreating
// them makes each (re)boot produce exactly one live timer instead of zero.
export function ensureSyncScheduler() {
  if (g.__syncTimers) {
    clearInterval(g.__syncTimers.main);
    clearInterval(g.__syncTimers.failsafe);
  }

  // Catch-up: if the server was down past an interval (or never synced), the
  // stored last_sync is stale — sync immediately instead of waiting a full tick.
  const last = getLastSync();
  const stale = !last || Date.now() - new Date(last).getTime() > INTERVAL_MS;
  if (stale) void runOnce("startup catch-up");

  const main = setInterval(() => void runOnce("scheduled"), INTERVAL_MS);
  // REMOVE LATER (see FAILSAFE_MS above): 4-hour backstop sync.
  const failsafe = setInterval(() => void runOnce("4h failsafe"), FAILSAFE_MS);
  g.__syncTimers = { main, failsafe };
}
