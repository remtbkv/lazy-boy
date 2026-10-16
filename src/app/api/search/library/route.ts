import { forUser, LIBRARY_INDEX_SHAPE } from "@/lib/db";
import { requireRouteUser } from "@/lib/require-user";
import { meteredBody } from "@/lib/budget/request-meter";

// The library half of Home's search: every track in a playlist or in Liked Songs, as
// [name, artist, image, album, playlists] (see "The client-side search payloads" in
// src/lib/db.ts for the shape and the sizes). Fetched once per visit — on idle after Home
// mounts, so the build is already paid for by the time the box is focused.
//
// It is PERSONAL data — one person's library — so it is gated (requireRouteUser) and served
// `private, no-store` (multi-user PLAN §6.2 layer 6, §9.1): a body in the browser's HTTP
// cache outlives a sign-out on a shared computer, where no page script can evict it. The
// browser's own copy lives in page memory (and phase E's IndexedDB store), which sign-out
// clears. The body names its user (`u`), and the client drops one that names someone else.
// The ETag carries the uid and the store epoch: per-user versions are small integers that
// collide across users, and a restored database starts its versions over.
//
// A signed-out caller gets the gate's 401 (with the signed-out marker) rather than an empty
// payload: the client falls back to the server-side search when this route fails, which is
// the correct behaviour for "we don't know who you are" and the wrong one to paper over with
// `[]`. An identity check that could not run answers 503, which clears nothing.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireRouteUser();
  if (user instanceof Response) return user;
  const store = forUser(user.uid);

  const version = await store.getLibraryIndexVersion();
  // Version unknown (store hiccup): serve a fresh, untagged body. Tagging it with a guessed
  // version would let a browser 304 against a body nothing can vouch for.
  if (version === null) {
    const index = await store.getLibraryIndex(null);
    return new Response(meteredBody(JSON.stringify({ v: null, u: user.uid, ...index })), {
      headers: { "Cache-Control": "private, no-store", "Content-Type": "application/json" },
    });
  }
  // LIBRARY_INDEX_SHAPE is the payload format — the SAME token that keys the server-side
  // cache entry (db.ts), so one bump moves both layers and neither can serve a shape this
  // client can't read. The uid and the store epoch name whose body it is (see above). The
  // version is `meta.library_seq`, which moves when the library's membership does. The UTC
  // day bucket is the backstop: the version cannot see an in-place re-tag of a track's name
  // or art, so without it a stale copy could live indefinitely. With it, staleness is
  // bounded at ~24h.
  const epoch = await store.storeEpoch();
  const day = new Date().toISOString().slice(0, 10);
  const etag = `"lib-${LIBRARY_INDEX_SHAPE}-${user.uid}-${epoch}-${version}-${day}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Cache-Control": "private, no-store",
  };
  // A proxy may weaken the tag (W/"…") on the way back out; compare on the tag itself.
  if (req.headers.get("if-none-match")?.replace(/^W\//, "") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const index = await store.getLibraryIndex(version);
  return new Response(meteredBody(JSON.stringify({ v: version, u: user.uid, ...index })), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
