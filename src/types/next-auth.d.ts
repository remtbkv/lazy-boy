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
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: "RefreshAccessTokenError";
  }
}
