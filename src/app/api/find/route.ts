import { auth } from "@/lib/auth";
import { searchPlaylistSongs } from "@/lib/db";

// Fuzzy-find songs that appear in any of the user's playlists (local store, no Spotify
// call — instant). Powers the Find quick-lookup.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ results: await searchPlaylistSongs(q) });
}
