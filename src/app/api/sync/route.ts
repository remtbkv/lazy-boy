import { auth, spotifyAccessToken } from "@/lib/auth";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { getLastSync, ledgerSyncCall } from "@/lib/db";
import { syncRecentPlays } from "@/lib/sync/history";

// In-app history sync. SyncOnLoad pings this on load, every 2 min while open, and on
// tab-focus; this server-side debounce coalesces those (and multiple tabs / quick
// navigations) so we only actually hit Spotify when a sync is genuinely due. Kept just
// under the client's 2-min cadence so each real poll goes through. Times the app is
// closed are covered by the GitHub Actions cron (every 5 min) → /api/cron/sync.
const STALE_MS = 60 * 1000;

export async function POST() {
  const session = await auth();
  // Short-circuited so an unauthenticated POST costs no tokens read.
  const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;
  if (!accessToken) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const last = await getLastSync();
  if (last && Date.now() - new Date(last).getTime() < STALE_MS) {
    return Response.json({ ok: true, skipped: true });
  }
  try {
    const { added, skipped } = await syncRecentPlays(spotifyClient(accessToken, false, "onload-sync"));
    // The open tab's share of the burn, kept separate from the cron's: the debounce above
    // already returned for the calls that did no work, so what reaches here really synced.
    if (!skipped) void ledgerSyncCall("sync_onload", added);
    return Response.json({ ok: true, added, skipped });
  } catch (e) {
    // A rate-limit self-heals; don't 500 the open app's background poll over it.
    if (e instanceof SpotifyError && e.status === 429) {
      return Response.json({ ok: true, skipped: "rate-limited" });
    }
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}
