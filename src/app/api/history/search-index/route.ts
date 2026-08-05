import { auth } from "@/lib/auth";
import { getSearchIndex, getSearchIndexVersion } from "@/lib/db";

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

// BUMP THIS whenever the JSON shape changes. Caught in testing, not theory: adding album art
// left the data version and the day bucket unchanged, so a browser holding yesterday's body
// revalidated to a 304 and kept parsing the OLD shape — art silently absent until the deploy
// rolled past midnight. The data version answers "is the content current"; nothing else
// answered "can this client still read it".
const SHAPE = "v2";

export async function GET(req: Request) {
  if (!(await auth())) return new Response("Unauthorized", { status: 401 });

  const version = await getSearchIndexVersion();
  // Three parts. SHAPE is the format (above). The version moves when `tracks` gains a row (a
  // song played for the first time) — that is the real content invalidation. The UTC day bucket
  // is the backstop: the version cannot see an in-place re-tag of a track's name or art, so
  // without it a stale entry could live in a browser cache indefinitely. With it, staleness is
  // bounded at ~24h.
  const etag = `"si-${SHAPE}-${version}-${new Date().toISOString().slice(0, 10)}"`;
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
