import { auth } from "@/lib/auth";
import { getSongListens } from "@/lib/db";

// When did I last listen to this song? Total plays + recent timestamps, from the local
// listen-history store (no Spotify call). `id` is a track id from the Find search.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });
  return Response.json(await getSongListens(id));
}
