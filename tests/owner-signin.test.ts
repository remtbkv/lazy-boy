// S1: only the owner's Spotify account may sign in. The store is single-user — a second
// account completing sign-in would replace the global token and the cron would start
// recording its plays into the owner's history. Auth.js runs the signIn callback before the
// jwt callback (the one that writes the token), and a false/throw there is AccessDenied, so
// the decision is the whole guard. It lives in lib/owner.ts because auth.ts pulls in
// next/server, which the simulated environment can't load.
import { beforeEach, describe, expect, it } from "vitest";
import { isOwnerSignIn } from "@/lib/owner";
import { rawClient, resetStore } from "./adversarial/helpers";
import { ownerStore, seedOwnerApp } from "./owner-store";

const getSpotifyTokens = () => ownerStore().getSpotifyTokens();
const setSpotifyTokens = (t: typeof OWNER_TOKENS) => ownerStore().setSpotifyTokens(t);

async function setMeId(id: string): Promise<void> {
  const c = await rawClient();
  await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('me_id', ?)", args: [id] });
}

const OWNER_TOKENS = { accessToken: "owner-at", refreshToken: "owner-rt", expiresAt: 2_000_000_000 };

beforeEach(async () => {
  delete process.env.SPOTIFY_OWNER_ID;
  await resetStore();
  await seedOwnerApp(); // the admin's users row names his database (Phase 2)
  await setSpotifyTokens(OWNER_TOKENS);
});

describe("isOwnerSignIn", () => {
  it("SPOTIFY_OWNER_ID set: the owner passes, anyone else is refused and the token is untouched", async () => {
    process.env.SPOTIFY_OWNER_ID = "rem";
    expect(await isOwnerSignIn("rem")).toBe(true);
    expect(await isOwnerSignIn("friend")).toBe(false);
    expect(await getSpotifyTokens()).toEqual(OWNER_TOKENS);
  });

  it("the env var wins over a stored me_id that a past intruder already flipped", async () => {
    process.env.SPOTIFY_OWNER_ID = "rem";
    await setMeId("friend");
    expect(await isOwnerSignIn("rem")).toBe(true);
    expect(await isOwnerSignIn("friend")).toBe(false);
  });

  it("env unset: falls back to the stored me_id", async () => {
    await setMeId("rem");
    expect(await isOwnerSignIn("rem")).toBe(true);
    expect(await isOwnerSignIn("friend")).toBe(false);
  });

  it("env unset and an empty store: the first login is let through", async () => {
    expect(await isOwnerSignIn("anyone")).toBe(true);
  });

  it("an owner is known but the profile carries no id: refused", async () => {
    process.env.SPOTIFY_OWNER_ID = "rem";
    expect(await isOwnerSignIn(undefined)).toBe(false);
  });
});
