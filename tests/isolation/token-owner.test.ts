// The Spotify client is made for a user (PLAN.md §5.2's last row): every token it sends must
// name that user, and every call it logs carries them. A token naming anyone else, or naming no
// one, is refused before a request leaves, with an isolation event: a refactor that shares a
// token, a promise or a cache across users fails on its first mixed call.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spotifyClient, TokenOwnerError } from "@/lib/spotify";
import { resetStore } from "../adversarial/helpers";
import { A, B } from "./harness";

const sent: string[] = [];

beforeEach(async () => {
  await resetStore();
  sent.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.spotify.com/")) {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ id: "someone" });
    }
    return fetch(input, init);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function telemetry(sql: string): Promise<Record<string, unknown>[]> {
  // Fire-and-forget writes: give them a moment to land.
  await new Promise((r) => setTimeout(r, 50));
  const c = createClient({ url: process.env.TURSO_DATABASE_URL as string });
  const r = await c.execute(sql);
  c.close();
  return r.rows.map((x) => ({ ...x }));
}

describe("the Spotify client and its owner", () => {
  it("a token naming the client's user is sent, and its api_log row carries that user", async () => {
    await spotifyClient(A, { uid: A, accessToken: "at-a" }).me();
    expect(sent).toEqual(["Bearer at-a"]);
    const rows = await telemetry("SELECT user_id FROM api_log");
    expect(rows).toEqual([{ user_id: A }]);
  });

  it("a token naming another user is refused before any request, and recorded", async () => {
    await expect(spotifyClient(A, { uid: B, accessToken: "at-b" }).me()).rejects.toBeInstanceOf(TokenOwnerError);
    await expect(spotifyClient(A, async () => ({ uid: B, accessToken: "at-b" })).me()).rejects.toBeInstanceOf(TokenOwnerError);
    expect(sent).toEqual([]);
    const events = await telemetry("SELECT meta FROM client_metrics WHERE event = 'isolation'");
    expect(events).toEqual([{ meta: `token-owner|${A}` }, { meta: `token-owner|${A}` }]);
  });

  it("a bare string, which names no one, is refused for a user's client", async () => {
    await expect(spotifyClient(A, "at-anyone").me()).rejects.toBeInstanceOf(TokenOwnerError);
    expect(sent).toEqual([]);
  });
});
