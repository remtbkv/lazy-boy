import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { getLastSync } from "@/lib/db";
import { syncRecentPlays } from "@/lib/sync/history";

// In-app history sync. SyncOnLoad pings this on load, every 2 min while open, and on
// tab-focus; this server-side debounce coalesces those (and multiple tabs / quick
// navigations) so we only actually hit Spotify when a sync is genuinely due. Kept just
// under the client's 2-min cadence so each real poll goes through. Times the app is
// closed are covered by the GitHub Actions cron (every 5 min) → /api/cron/sync.
const STALE_MS = 60 * 1000;

export async function POST() {
  const session = await auth();
  if (!session?.accessToken || session.error) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const last = await getLastSync();
  if (last && Date.now() - new Date(last).getTime() < STALE_MS) {
    return Response.json({ ok: true, skipped: true });
  }
  try {
    const { added } = await syncRecentPlays(spotifyClient(session.accessToken));
    return Response.json({ ok: true, added });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}
