import { syncPlaylistsFromSpotify } from "@/lib/playlists-sync";

// Triggered by the client when the stored library is empty or stale. Does the one
// expensive full scan off the render path, so pages stay instant.
export async function POST() {
  try {
    const r = await syncPlaylistsFromSpotify();
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: msg === "unauthorized" ? 401 : 500 });
  }
}
