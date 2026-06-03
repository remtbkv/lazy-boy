import { auth } from "@/lib/auth";
import { getAllTimePlays } from "@/lib/db";

// Most-played tracks all-time, read from the local store — instant. Capped (default
// 300) so the list stays bounded even for libraries with thousands of songs.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const limit = Math.min(1000, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 300)));
  return Response.json({ results: getAllTimePlays(limit) });
}
