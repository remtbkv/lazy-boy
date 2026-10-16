// What /login says when sign-in fails. The code is the `error` query parameter that Auth.js
// (pages.error = "/login") or the signIn callback (SpotifyNotRegistered, SpotifyUnavailable and
// the app database's refusals, identity-read.ts) puts on the URL; `on` is a deleted account's date.
import { signInRefusalMessage } from "@/lib/identity-read";

export function loginErrorMessage(code: string | undefined, on?: string): string | null {
  if (!code) return null;
  if (code === "SpotifyNotRegistered") {
    return (
      "Spotify didn't let this account in. Lazy Boy is in Spotify's development mode, so " +
      "only accounts its owner has added in the Spotify developer dashboard can connect."
    );
  }
  if (code === "SpotifyUnavailable") return "Spotify didn't answer just now, so sign-in couldn't finish. Try again in a minute.";
  if (code === "AccessDenied") {
    return "This Spotify account has no place on Lazy Boy yet. Ask Rem for one with the request form at /join.";
  }
  return signInRefusalMessage(code, on) ?? `Sign-in didn't complete (${code}). Try again.`;
}
