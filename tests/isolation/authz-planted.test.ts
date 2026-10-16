// The authz oracle's self-test (PLAN §6.4: a test that has never failed proves nothing). Each
// planted bug is an entry point broken the way a real one could be; observe() must call it
// "allow" for a principal whose cell says deny or isolated, which is what makes those cells
// fail. If a planted bug ever reads as deny, the oracle has lost its teeth.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));

import { cookies } from "next/headers";
import { decode } from "next-auth/jwt";
import { SECRETS, installSpotify, observe, request, type Principal } from "./authz-harness";
import { expectedObservations } from "./authz-cells";
import { ENTRIES } from "./authz-registry";

installSpotify();

// Decodes the session cookie with the right secret and stops there: no identity check. Kept off
// src/lib/auth.ts so the planted bugs stay bugs whatever that file's own checks become.
async function cookieDecodes(): Promise<boolean> {
  const raw = (await cookies()).get("authjs.session-token")?.value;
  if (!raw) return false;
  return !!(await decode({ token: raw, secret: SECRETS.auth, salt: "authjs.session-token" }).catch(() => null));
}

const PLANTED: { name: string; as: Principal; fn: () => Promise<unknown> }[] = [
  {
    name: "a route with no gate serving the library index",
    as: "anon",
    fn: async () => {
      const { getLibraryIndex } = await import("@/lib/db");
      return Response.json(await getLibraryIndex(null));
    },
  },
  {
    name: "a gate that checks the cookie is present instead of decoding it",
    as: "forged",
    fn: async () => {
      if (!(await cookies()).has("authjs.session-token")) return new Response(null, { status: 401 });
      const { getStoredPlaylists } = await import("@/lib/db");
      return Response.json(await getStoredPlaylists());
    },
  },
  {
    name: "a cron gate that accepts any Bearer header",
    as: "zenbookRecorder",
    fn: async () => {
      const req = request("/api/cron/sync");
      if (!req.headers.get("authorization")?.startsWith("Bearer ")) return new Response(null, { status: 401 });
      const { getValidAccessToken } = await import("@/lib/auth");
      const { spotifyClient } = await import("@/lib/spotify");
      const t = await getValidAccessToken();
      await spotifyClient(t!, false, "planted").currentlyPlaying();
      return Response.json({ ok: true });
    },
  },
  {
    name: "an action that writes before its gate refuses",
    as: "anon",
    fn: async () => {
      const { clearSpotifyTokens } = await import("@/lib/db");
      await clearSpotifyTokens();
      return { ok: false, error: "Not authenticated" };
    },
  },
  {
    name: "a gate that decodes the cookie but asks nothing about who it names (a revoked friend through)",
    as: "revoked",
    fn: async () => {
      if (!(await cookieDecodes())) return [];
      const { searchHistory } = await import("@/lib/db");
      return searchHistory("", 5);
    },
  },
  {
    name: "a route that hands the stored Spotify token to the browser",
    as: "friendA",
    fn: async () => {
      if (!(await cookieDecodes())) return new Response(null, { status: 401 });
      const { getSpotifyTokens } = await import("@/lib/db");
      return Response.json({ token: (await getSpotifyTokens())?.accessToken });
    },
  },
];

describe("planted bugs: the oracle reads each as allow", () => {
  for (const b of PLANTED) {
    it(b.name, async () => {
      const obs = await observe(b.as, b.fn);
      expect(obs.observed).toBe("allow");
      // …and the cell shapes that guard real entry points would reject it.
      const anyEntry = ENTRIES.find((e) => e.cells[b.as].target !== "allow" && !e.cells[b.as].today)!;
      expect(expectedObservations(anyEntry, { ...anyEntry.cells[b.as], today: undefined })).not.toContain("allow");
    });
  }
});
