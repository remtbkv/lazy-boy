// Who may sign in. The store is single-user: the jwt callback writes the signing-in account's
// tokens over the one global `spotify_tokens` row, and the cron harvests with whatever sits
// there — so a second account completing sign-in would hijack history capture and flip
// `me_id`. auth.ts's signIn callback asks this before Auth.js ever reaches the jwt callback.
import { adminStore } from "@/lib/identity-read";

// The owner is SPOTIFY_OWNER_ID (set in prod and .env.local). Unset, the admin's stored `me_id`
// stands in; with neither, this is the first login on an empty store and it is let through. A
// store error throws, which Auth.js turns into AccessDenied — fail closed.
export async function isOwnerSignIn(profileId: string | undefined): Promise<boolean> {
  const owner = process.env.SPOTIFY_OWNER_ID || (await (await adminStore())?.getMeId()) || null;
  if (!owner) return true;
  return profileId === owner;
}
