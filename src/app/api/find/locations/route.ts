import { auth } from "@/lib/auth";
import { getArtistSongLocations, getSongPlaylists } from "@/lib/db";

// Where a song / artist lives in your playlists (name + position) so Find can deep-link
// to the exact spot. Pass `id` (track id) for a song, or `artist` (name) for an artist.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const artist = url.searchParams.get("artist");
  if (artist) return Response.json({ locations: await getArtistSongLocations(artist) });
  if (id) return Response.json({ locations: await getSongPlaylists(id) });
  return Response.json({ error: "missing id or artist" }, { status: 400 });
}
