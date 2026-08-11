// Server-only helper: an authed Spotify service bound to the current session token.
// On a missing/expired session it redirects to /login (consistent with the (app)
// layout gate) instead of throwing, so pages don't surface noisy auth errors.
import "server-only";
import { redirect } from "next/navigation";
import { auth, spotifyAccessToken } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";

export async function getSpotify() {
  // auth() FIRST, then the token: the jwt callback inside auth() is what refreshes an expired
  // token and publishes it for spotifyAccessToken() to read. Never parallelize these two.
  // Short-circuited on purpose — a caller with no session must not pay a tokens read.
  const session = await auth();
  const accessToken = session && !session.error ? await spotifyAccessToken() : undefined;
  if (!accessToken) {
    redirect("/login");
  }
  return spotifyClient(accessToken);
}
