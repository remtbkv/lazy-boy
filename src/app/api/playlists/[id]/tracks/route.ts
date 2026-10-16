import { spotifyAccessTokenFor } from "@/lib/auth";
import { requireRouteUser } from "@/lib/require-user";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { forUser } from "@/lib/db";
import { allowUserCall, PLAYLIST_TRACKS_LIMIT } from "@/lib/user-bucket";

// Background freshness check for one playlist's cached track list. The detail page renders
// from the DB cache instantly and fires this; here we make ONE cheap call to read the
// current snapshot_id and only re-paginate (the expensive part) when it differs from the
// cached one the client sent. An unchanged playlist costs a single request, not a full
// re-scan — which is what keeps detail pages fast and off Spotify's rate limiter.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireRouteUser();
  if (user instanceof Response) return user;
  // §6.6: ten a minute per user per instance, so a stuck tab cannot spend Spotify's shared window.
  if (!allowUserCall("playlist-tracks", user.uid, Date.now(), PLAYLIST_TRACKS_LIMIT.limit, PLAYLIST_TRACKS_LIMIT.windowMs)) {
    return Response.json({ ok: false, error: "slow down", retry: true }, { status: 429, headers: { "retry-after": "60" } });
  }
  const accessToken = await spotifyAccessTokenFor(user.uid);
  if (!accessToken) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { snapshot?: unknown };
    const cachedSnapshot = typeof body.snapshot === "string" ? body.snapshot : undefined;
    const sp = spotifyClient(user.uid, accessToken, false, "playlist-resync");

    const playlist = await sp.playlist(id);
    if (cachedSnapshot && playlist.snapshot && playlist.snapshot === cachedSnapshot) {
      return Response.json({ ok: true, changed: false });
    }

    const tracks = await sp.playlistTracks(id);
    await forUser(user.uid).storePlaylistTracks(id, tracks, playlist.snapshot);
    return Response.json({ ok: true, changed: true, count: tracks.length });
  } catch (e) {
    // A rate-limited Spotify is not a server error — report it as what it is so the
    // client (and the logs) don't read a routine cooldown as a 500 (Rem, 2026-08-16).
    const status = e instanceof SpotifyError && e.status === 429 ? 429 : 500;
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status },
    );
  }
}
