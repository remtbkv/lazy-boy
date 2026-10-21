import { forUser, HISTORY_INDEX_SHAPE } from "@/lib/db";
import { requireRouteUser } from "@/lib/require-user";

// The history half of Home's search: every played song plus every individual play, as
// [track, minute, source] (see "The client-side search payloads" in src/lib/db.ts). This is
// what puts the play count, the last-played time and the expanded per-play list on a result
// row without a follow-up request.
//
// Same gate and caching contract as the library route — personal data, `private, no-store`,
// the uid and the store epoch in the ETag, `u` in the body. This one is the small, volatile
// half: its version is the write marker, so it moves whenever a song finishes.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireRouteUser();
  if (user instanceof Response) return user;
  const store = forUser(user.uid);

  const version = await store.getHistoryIndexVersion();
  // Version unknown (store hiccup): fresh and untagged, same contract as the library route.
  if (version === null) {
    const index = await store.getHistoryIndex(null);
    return new Response(JSON.stringify({ v: null, u: user.uid, ...index }), {
      headers: { "Cache-Control": "private, no-store", "Content-Type": "application/json" },
    });
  }
  const epoch = await store.storeEpoch();
  const day = new Date().toISOString().slice(0, 10);
  const etag = `"hist-${HISTORY_INDEX_SHAPE}-${user.uid}-${epoch}-${version}-${day}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-store",
  };
  if (req.headers.get("if-none-match")?.replace(/^W\//, "") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const index = await store.getHistoryIndex(version);
  return new Response(JSON.stringify({ v: version, u: user.uid, ...index }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
