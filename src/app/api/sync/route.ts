import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { getLastSync } from "@/lib/db";
import { syncRecentPlays } from "@/lib/sync/history";

// On-load history sync (replaces the old setInterval scheduler, which can't run on
// serverless). The client pings this when the app is opened; the server decides
// whether a sync is actually due, so frequent navigation doesn't hammer Spotify.
// A daily Vercel Cron (/api/cron/sync) backs this up for when the app isn't open.
const STALE_MS = 5 * 60 * 1000;

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
