import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app's Spotify redirect URI is on 127.0.0.1, but `next dev` serves from
  // localhost — Next 16 treats that as cross-origin and blocks /_next dev
  // resources (HMR + client runtime), which silently breaks hydration so no
  // buttons work. Allow both hosts in dev.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // better-sqlite3 is a native module — don't bundle it, load it from node_modules.
  serverExternalPackages: ["better-sqlite3"],
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
