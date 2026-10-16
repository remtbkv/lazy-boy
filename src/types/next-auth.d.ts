// Module augmentation so the access token / refresh state are typed on the JWT and session.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  // NO `accessToken` here, deliberately — whatever this interface carries, Auth.js serializes
  // to the browser at GET /api/auth/session. `error` is the only extra the client needs (it
  // drives the log-in-again state); the Spotify token is server-only and comes from
  // `spotifyAccessToken()` in src/lib/auth.ts. Its absence from this type is what makes
  // `session.accessToken` a compile error rather than a leak.
  interface Session {
    error?: "RefreshAccessTokenError";
    user: DefaultSession["user"];
    // Multi-user Phase 1 (docs/multi-user/PLAN.md §5.1): the user the request runs as, set only
    // when the identity check allowed it. Not a credential. `idUnavailable` means the check
    // could not run; requireUser() answers that with a retryable error, never a sign-out.
    uid?: string;
    admin?: boolean;
    /** The cookie's sign-in time (epoch s), for Disconnect's ten-minute rule (PLAN.md §5.4). */
    authTime?: number;
    idUnavailable?: true;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    ep?: number;
    auth_time?: number;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: "RefreshAccessTokenError";
  }
}
