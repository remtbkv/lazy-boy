// The request form's POST (RULINGS Oct 15 12:46 PM; PLAN.md §12.1). No session: this is a
// friend's first visit. It stores one request through app-db.ts createJoinRequest, which bounds
// what a stranger can store and is shut under SIGNUPS=owner, and leaves the signed request cookie
// the friend's sign-in claims. It creates no database and calls nothing outside the app database.
// A plain form post (no script needed), answered 303 back to /join either way.
import { createJoinRequest } from "@/lib/app-db";
import { requestCookieHeader } from "@/lib/request-cookie";

export const dynamic = "force-dynamic";

const MAX_BODY = 4_096;

const back = (q: string, cookie?: string) =>
  new Response(null, { status: 303, headers: { location: `/join${q}`, ...(cookie ? { "set-cookie": cookie } : {}) } });

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return back("?error=email");
  const text = await req.text();
  if (text.length > MAX_BODY) return back("?error=email");
  const form = new URLSearchParams(text);
  const now = Date.now();
  let r: Awaited<ReturnType<typeof createJoinRequest>>;
  try {
    r = await createJoinRequest({
      email: form.get("email") ?? "",
      name: form.get("name") ?? "",
      agreed: form.get("agree") === "on",
      now,
    });
  } catch (e) {
    console.error(`[join] request not stored: ${String(e)}`);
    return back("?error=unavailable");
  }
  if (!r.ok) return back(`?error=${r.reason}`);
  return back("", requestCookieHeader(r.id, now, new URL(req.url).protocol === "https:"));
}
