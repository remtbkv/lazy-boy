import { auth } from "@/lib/auth";
import { getSearchIndex, getSearchIndexVersion, SEARCH_INDEX_SHAPE } from "@/lib/db";

// The compact search index Home filters in the browser: every played track as
// [id, name, artist, image] (see "The client-side search index" in src/lib/db.ts for the shape,
// the sizes and why play counts are not in it). Fetched once per visit — on idle after Home
// mounts, so the build is already paid for by the time the box is focused.
//
// It is PERSONAL data — one person's listening history — so it is authed and marked
// `private`: it must never land in a shared or CDN cache, the same reasoning the day/playlist
// read cache carries. `max-age=0, must-revalidate` keeps the body in the BROWSER cache but
// makes the browser ask every time, so a newly played song shows up on the next page load
// instead of waiting out a TTL — and the ask costs a 304 with no body.
//
// A signed-out caller gets 401 rather than an empty index: the client falls back to the
// server-side search when this route fails, which is the correct behaviour for "we don't know
// who you are" and the wrong one to paper over with `[]`.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await auth())) return new Response("Unauthorized", { status: 401 });

  const version = await getSearchIndexVersion();
  // Three parts. SEARCH_INDEX_SHAPE is the payload format — the SAME token that keys the
  // server-side cache entry (db.ts), so one bump moves both layers and neither can serve a
  // shape this client can't read. The version moves when `tracks` gains a row (a song played
  // for the first time), which is the real content invalidation. The UTC day bucket is the
  // backstop: the version cannot see an in-place re-tag of a track's name or art, so without it
  // a stale entry could live in a browser cache indefinitely. With it, staleness is bounded at
  // ~24h.
  const etag = `"si-${SEARCH_INDEX_SHAPE}-${version}-${new Date().toISOString().slice(0, 10)}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  // A proxy may weaken the tag (W/"…") on the way back out; compare on the tag itself.
  if (req.headers.get("if-none-match")?.replace(/^W\//, "") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const { images, tracks } = await getSearchIndex(version);
  return new Response(JSON.stringify({ v: version, images, tracks }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
