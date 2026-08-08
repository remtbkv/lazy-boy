// The build id of whatever deployment is CURRENT — the one signal a pinned tab can't fake.
//
// Vercel's skew protection routes a client's requests back to the deployment it was served
// from, so `/api/now-playing`'s beacon answers a stale tab with its own build id and the two
// agree forever. The escape is the cookie that does the pinning: the poller fetches this
// route with `credentials: "omit"`, no cookie goes out, and the request lands on the current
// deployment. That is the whole reason this route is unauthenticated — a request carrying no
// credentials is one the session can't be attached to. Safe: the id is a git sha, and the
// deployment it names is already public in every asset URL the browser has loaded.
//
// No auth, no DB, no session — nothing here may become expensive, since a tab hits it every
// ~5 minutes for as long as it is open. See docs/GOTCHAS.md "Deployment skew + stale tabs".
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { build: process.env.NEXT_PUBLIC_BUILD_ID },
    { headers: { "Cache-Control": "no-store" } },
  );
}
