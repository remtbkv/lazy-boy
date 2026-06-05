import { auth } from "@/lib/auth";
import { searchPlaylistArtists, searchPlaylistSongs } from "@/lib/db";

// Fuzzy-find songs (or artists, `mode=artist`) that appear in any of the user's
// playlists (local store, no Spotify call — instant). Powers the Find quick-lookup.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const mode = url.searchParams.get("mode") === "artist" ? "artist" : "song";
  const results =
    mode === "artist" ? await searchPlaylistArtists(q) : await searchPlaylistSongs(q);
  return Response.json({ results });
}
