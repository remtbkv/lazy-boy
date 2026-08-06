import { auth } from "@/lib/auth";
import { getHistoryIndex, getHistoryIndexVersion, HISTORY_INDEX_SHAPE } from "@/lib/db";

// The history half of Home's search: every played song plus every individual play, as
// [track, minute, source] (see "The client-side search payloads" in src/lib/db.ts). This is
// what puts the play count, the last-played time and the expanded per-play list on a result
// row without a follow-up request.
//
// Same auth and caching contract as the library route — personal data, `private`, revalidated
// on every load. This one is the small, volatile half: its version is the write marker, so it
// moves whenever a song finishes, and a repeat visit after listening re-downloads it in full
// rather than 304ing. That is the trade the split buys: the big body stays cached.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await auth())) return new Response("Unauthorized", { status: 401 });

  const version = await getHistoryIndexVersion();
  const etag = `"hist-${HISTORY_INDEX_SHAPE}-${version}-${new Date().toISOString().slice(0, 10)}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  if (req.headers.get("if-none-match")?.replace(/^W\//, "") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const index = await getHistoryIndex(version);
  return new Response(JSON.stringify({ v: version, ...index }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
