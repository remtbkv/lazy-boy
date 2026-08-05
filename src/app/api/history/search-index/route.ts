import { auth } from "@/lib/auth";
import { getSearchIndex, getSearchIndexVersion } from "@/lib/db";

// The compact search index Home filters in the browser: every played track as
// [id, name, artist] (see "The client-side search index" in src/lib/db.ts for the shape, the
// sizes and why stats are not in it). Fetched once, lazily, on first use of the search box.
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
  // Two parts. The version moves when `tracks` gains a row (a song played for the first time)
  // — that is the real invalidation. The UTC day bucket is the backstop: the version cannot
  // see an in-place re-tag of a track's name, so without it a stale entry could live in a
  // browser cache indefinitely. With it, staleness is bounded at ~24h.
  const etag = `"si-${version}-${new Date().toISOString().slice(0, 10)}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, max-age=0, must-revalidate",
  };
  // A proxy may weaken the tag (W/"…") on the way back out; compare on the tag itself.
  if (req.headers.get("if-none-match")?.replace(/^W\//, "") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const tracks = await getSearchIndex(version);
  return new Response(JSON.stringify({ v: version, tracks }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
