import { auth, spotifyAccessToken } from "@/lib/auth";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { storePlaylistTracks } from "@/lib/db";

// Background freshness check for one playlist's cached track list. The detail page renders
// from the DB cache instantly and fires this; here we make ONE cheap call to read the
// current snapshot_id and only re-paginate (the expensive part) when it differs from the
// cached one the client sent. An unchanged playlist costs a single request, not a full
// re-scan — which is what keeps detail pages fast and off Spotify's rate limiter.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  // Short-circuited so an unauthenticated POST costs no tokens read.
  const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;
  if (!accessToken) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { snapshot?: unknown };
    const cachedSnapshot = typeof body.snapshot === "string" ? body.snapshot : undefined;
    const sp = spotifyClient(accessToken, false, "playlist-resync");

    const playlist = await sp.playlist(id);
    if (cachedSnapshot && playlist.snapshot && playlist.snapshot === cachedSnapshot) {
      return Response.json({ ok: true, changed: false });
    }

    const tracks = await sp.playlistTracks(id);
    await storePlaylistTracks(id, tracks, playlist.snapshot);
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
