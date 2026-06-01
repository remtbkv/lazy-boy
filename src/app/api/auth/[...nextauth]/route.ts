import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

// Next.js normalizes 127.0.0.1 -> localhost in request URLs, so Auth.js builds its
// post-login redirect against `localhost`. Spotify requires the loopback IP literal,
// and our session cookies are set on 127.0.0.1, so the browser must stay there.
// Rewrite any `localhost` Location back to 127.0.0.1 after Auth.js handles the request.
function pinLoopback(res: Response): Response {
  const loc = res.headers.get("location");
  if (!loc || !loc.includes("localhost")) return res;
  const pinned = new Response(res.body, res);
  pinned.headers.set("location", loc.replaceAll("localhost", "127.0.0.1"));
  return pinned;
}

export async function GET(req: NextRequest) {
  return pinLoopback(await handlers.GET(req));
}

export async function POST(req: NextRequest) {
  return pinLoopback(await handlers.POST(req));
}
