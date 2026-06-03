import { auth } from "@/lib/auth";
import { searchHistory } from "@/lib/db";

// Searches the local listen-history store (no Spotify call), so it's instant.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ results: await searchHistory(q) });
}
