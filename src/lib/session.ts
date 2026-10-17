// Server-only helper: an authed Spotify service bound to the gated user's token.
// With no token (the row is gone) it redirects to /login (consistent with the page gates)
// instead of throwing, so pages don't surface noisy auth errors.
import "server-only";
import { redirect } from "next/navigation";
import { spotifyAccessTokenFor } from "@/lib/auth";
import type { Uid } from "@/lib/identity";
import { spotifyClient } from "@/lib/spotify";

export async function getSpotify(uid: Uid, source = "action") {
  // The gate FIRST (requirePageUser/requireActionUser, whose auth() runs the jwt callback that
  // refreshes an expired token and publishes it), then the token. Never parallelize the two.
  const accessToken = await spotifyAccessTokenFor(uid);
  if (!accessToken) {
    redirect("/login");
  }
  return spotifyClient(uid, accessToken, false, source);
}
