import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";

// Returns one page of the user's playlists. The page renders page 0 server-side
// for a fast first paint, then the client pulls the rest from here in the
// background. Auth is checked here (not via getSpotify) so an expired session
// returns 401 JSON instead of an HTML redirect that would break the fetch.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken || session.error) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const offset = Number(new URL(req.url).searchParams.get("offset") ?? "0");
  const sp = spotifyClient(session.accessToken);
  const { items, total } = await sp.myPlaylistsPage(offset, 50);
  return Response.json({ items, total });
}
