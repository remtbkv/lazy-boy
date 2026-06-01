// Server-only helper: an authed Spotify service bound to the current session token.
// On a missing/expired session it redirects to /login (consistent with the (app)
// layout gate) instead of throwing, so pages don't surface noisy auth errors.
import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";

export async function getSpotify() {
  const session = await auth();
  if (!session?.accessToken || session.error) {
    redirect("/login");
  }
  return spotifyClient(session.accessToken);
}
