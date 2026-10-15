// What /login says when sign-in fails. The code is the `error` query parameter that Auth.js
// (pages.error = "/login") or the signIn callback (SpotifyNotRegistered) puts on the URL.
export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "SpotifyNotRegistered") {
    return (
      "Spotify didn't let this account in. Lazy Boy is in Spotify's development mode, so " +
      "only accounts its owner has added in the Spotify developer dashboard can connect."
    );
  }
  if (code === "AccessDenied") {
    return "Lazy Boy is single-user for now: only its owner's Spotify account can connect.";
  }
  return `Sign-in didn't complete (${code}). Try again.`;
}
