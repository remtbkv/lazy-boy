import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Client-side Router Cache. Every page here is `force-dynamic`, and Next's default for
  // dynamic routes is staleTimes 0 — i.e. re-fetch the whole RSC payload on EVERY navigation,
  // including going Back to a page you were just on. That's why revisits felt as slow as first
  // loads.
  //
  // 30s. Memory is not the constraint (the whole app is ~460KB of RSC text — home ~170KB,
  // playlists ~245KB, friends ~43KB); staleness is. A shorter hold means new plays surface on
  // a normal revisit rather than being masked by a cached payload. A hard reload always
  // bypasses this either way.
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
  },
  // The app's Spotify redirect URI is on 127.0.0.1, but `next dev` serves from
  // localhost — Next 16 treats that as cross-origin and blocks /_next dev
  // resources (HMR + client runtime), which silently breaks hydration so no
  // buttons work. Allow both hosts in dev.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // libSQL/Turso client: the embedded `libsql` engine (used for the local file:
  // fallback in dev) is native — don't bundle it, load from node_modules.
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Baseline security headers. (A strict CSP needs per-request nonces for Next's
  // inline runtime — left as a production follow-up; see docs/SECURITY.md.)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
