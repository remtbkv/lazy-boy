import { auth } from "@/lib/auth";
import { getArtistListens, getSongListens } from "@/lib/db";

// When did I last listen to this song / artist? Total plays + recent timestamps from the
// local listen-history store (no Spotify call). Pass `id` (a track id) for a song, or
// `artist` (a name) for an artist.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const artist = url.searchParams.get("artist");
  if (artist) return Response.json(await getArtistListens(artist));
  if (id) return Response.json(await getSongListens(id));
  return Response.json({ error: "missing id or artist" }, { status: 400 });
}
