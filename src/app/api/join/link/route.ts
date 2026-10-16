// The join link Rem sends once he has approved a request (`invite.mjs --approve` prints it), for a
// friend signing in from another browser than the one that filled in the form (FASTPATH.md §5).
// Its token is a random capability whose hash alone is in the app database; while the invite is
// unclaimed and under 14 days old it sets the same signed request cookie the form sets, then
// sends the friend to /join to connect. It reads no user data and writes nothing.
import { requestForJoinToken } from "@/lib/app-db";
import { joinTokenHash, requestCookieHeader } from "@/lib/request-cookie";

export const dynamic = "force-dynamic";

const back = (q: string, cookie?: string) =>
  new Response(null, { status: 303, headers: { location: `/join${q}`, ...(cookie ? { "set-cookie": cookie } : {}) } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return back("?error=link");
  const now = Date.now();
  let rid: string | null;
  try {
    rid = await requestForJoinToken(joinTokenHash(token), now);
  } catch (e) {
    console.error(`[join] link not checked: ${String(e)}`);
    return back("?error=unavailable");
  }
  if (!rid) return back("?error=link");
  return back("", requestCookieHeader(rid, now, url.protocol === "https:"));
}
