import { cookies } from "next/headers";
import { spotifyAccessTokenFor } from "@/lib/auth";
import { forUser } from "@/lib/db";
import { requireRouteUser } from "@/lib/require-user";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { syncRecentPlays } from "@/lib/sync/history";

// In-app history sync. SyncOnLoad pings this on load, every 2 min while open, and on
// tab-focus; this server-side debounce coalesces those (and multiple tabs / quick
// navigations) so we only actually hit Spotify when a sync is genuinely due. Kept just
// under the client's 2-min cadence so each real poll goes through. Times the app is
// closed are covered by the Zenbook's 2-min timer → /api/cron/sync.
const STALE_MS = 60 * 1000;

export async function POST() {
  // The gate first, so an unauthenticated POST costs no tokens read.
  const user = await requireRouteUser();
  if (user instanceof Response) return user;
  const accessToken = await spotifyAccessTokenFor(user.uid);
  if (!accessToken) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const store = forUser(user.uid);
  // Publish the browser's tz offset so write-path day bucketing (the home payload) and
  // cookie-less requests use the reader's zone instead of a hardcoded one. Once per load,
  // fire-and-forget.
  const tzRaw = Number((await cookies()).get("tzoffset")?.value);
  if (Number.isFinite(tzRaw)) {
    void store.setUserTzOffset(Math.max(-720, Math.min(840, Math.round(tzRaw)))).catch(() => {});
  }
  const last = await store.getLastSync();
  if (last && Date.now() - new Date(last).getTime() < STALE_MS) {
    return Response.json({ ok: true, skipped: true });
  }
  try {
    const { added, skipped } = await syncRecentPlays(
      spotifyClient(user.uid, accessToken, false, "onload-sync"),
      store,
    );
    // The open tab's share of the burn, kept separate from the cron's: the debounce above
    // already returned for the calls that did no work, so what reaches here really synced.
    if (!skipped) void store.ledgerSyncCall("sync_onload", added);
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
