// Phase 1's token store over the real (simulated) `meta` row: the owner's uid reaches today's
// plaintext row; any other uid has none, so it reads null and cannot write, clear or lock it.
import { beforeEach, describe, expect, it } from "vitest";
import { getSpotifyTokens, setSpotifyTokens } from "@/lib/db";
import { ownerTokenStore } from "@/lib/token-store-owner";
import { resetStore } from "../adversarial/helpers";
import { A, B, FAR } from "./harness";

const OWNER_ROW = { accessToken: "owner-at", refreshToken: "owner-rt", expiresAt: FAR };

beforeEach(async () => {
  await resetStore();
  await setSpotifyTokens(OWNER_ROW);
});

describe("ownerTokenStore", () => {
  const store = ownerTokenStore(() => A);

  it("the owner's uid reads today's row", async () => {
    expect(await store.get(A)).toEqual(OWNER_ROW);
  });

  it("another uid reads nothing and cannot write, clear or lock the owner's row", async () => {
    expect(await store.get(B)).toBeNull();
    await expect(store.set(B, { accessToken: "x", refreshToken: "y", expiresAt: 1 })).rejects.toThrow();
    await expect(store.clear(B)).rejects.toThrow();
    await expect(store.lock(B, 1000)).rejects.toThrow();
    expect(await getSpotifyTokens()).toEqual(OWNER_ROW);
  });

  it("with no owner configured nobody has a row", async () => {
    const none = ownerTokenStore(() => null);
    expect(await none.get(A)).toBeNull();
    await expect(none.set(A, OWNER_ROW)).rejects.toThrow();
  });

  it("the owner's lock is today's spotify_refresh lease", async () => {
    const owner = await store.lock(A, 30_000);
    expect(owner).not.toBeNull();
    expect(await store.lock(A, 30_000)).toBeNull();
    await store.unlock(A, owner!);
    expect(await store.lock(A, 30_000)).not.toBeNull();
  });
});
