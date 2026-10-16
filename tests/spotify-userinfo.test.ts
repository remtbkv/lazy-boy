// 2026-10-14, production: an account outside the Spotify app's dev-mode allowlist tried to
// connect. GET /v1/me answered 403 with a plain-text body, Auth.js JSON-parsed it, and the
// SyntaxError surfaced as the generic "server configuration" page. spotifyUserinfo reads the
// profile itself; a refusal becomes the SPOTIFY_NOT_REGISTERED profile, which the signIn
// callback sends to /login?error=SpotifyNotRegistered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPOTIFY_NOT_REGISTERED, SPOTIFY_UNAVAILABLE, spotifyUserinfo } from "@/lib/spotify/userinfo";
import { loginErrorMessage } from "@/lib/login-error";

// The body Spotify sent, as far as the production log shows it ("The user i...").
const NOT_REGISTERED_BODY =
  "The user is not registered for this application. Please contact the app owner.";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("spotifyUserinfo", () => {
  it("a plain-text 403 (account not on the allowlist) becomes the not-registered profile, no throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(NOT_REGISTERED_BODY, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = await spotifyUserinfo({ tokens: { access_token: "at" } });
    expect(p.id).toBe(SPOTIFY_NOT_REGISTERED);
    expect(p.images).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.spotify.com/v1/me", {
      headers: { Authorization: "Bearer at" },
      cache: "no-store",
    });
  });

  it("a 200 returns Spotify's profile unchanged", async () => {
    const me = { id: "rem", display_name: "Rem", email: "r@x", images: [{ url: "u" }], country: "US" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(me), { status: 200 })));
    expect(await spotifyUserinfo({ tokens: { access_token: "at" } })).toEqual(me);
  });

  // Multi-user PLAN.md §5.1, Phase 4a: only a 403 means "not registered". A passing 429 or a 5xx
  // would otherwise tell an invited friend they are not allowed in; it is "try again" instead.
  it("any other refusal (429, 500, 502, JSON or not) is the unavailable profile, never not-registered and never a throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const status of [429, 500, 502, 401]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream down", { status })));
      expect((await spotifyUserinfo({ tokens: { access_token: "at" } })).id, String(status)).toBe(SPOTIFY_UNAVAILABLE);
    }
  });
});

describe("loginErrorMessage", () => {
  it("names the dev-mode allowlist, the single-user rule, and falls back with the code", () => {
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("SpotifyNotRegistered")).toMatch(/development mode/);
    expect(loginErrorMessage("AccessDenied")).toMatch(/single-user/);
    expect(loginErrorMessage("Configuration")).toBe("Sign-in didn't complete (Configuration). Try again.");
  });
});

describe("the scopes (PLAN.md §12.1)", () => {
  it("ask for today's thirteen until the probe says account_id survives without the two profile scopes", async () => {
    const { DROP_PROFILE_SCOPES, spotifyScopes } = await import("@/lib/scopes");
    expect(DROP_PROFILE_SCOPES).toBe(false);
    const today = spotifyScopes().split(" ");
    expect(today).toHaveLength(13);
    expect(today.slice(0, 2)).toEqual(["user-read-private", "user-read-email"]);
    const dropped = spotifyScopes(true).split(" ");
    expect(dropped).toEqual(today.filter((s) => s !== "user-read-private" && s !== "user-read-email"));
  });
});
