// Decision 20 as ruled (RULINGS Oct 15 1:17 PM): a session whose Spotify grant has died is shown
// what happened and what to do (/reconnect), then the sign-in page; never a silent redirect. Phase
// 1's turn refuses such a session on every entry point; the pages send it to /reconnect, and a
// session with no cookie at all still goes to /login. Through the real Auth.js over the harness.
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));
vi.mock("next/font/google", () => ({ Figtree: () => ({ variable: "" }), Geist_Mono: () => ({ variable: "" }) }));

import { appDatabaseUrl } from "@/lib/app-db";
import { OWNER_UID, become, installSpotify, params, REM_PLAYLIST, run, seedRem } from "./authz-harness";

const PAGES: [string, () => Promise<unknown>][] = [
  ["/home", async () => (await import("@/app/(app)/home/page")).default()],
  ["/playlists", async () => (await import("@/app/(app)/playlists/page")).default()],
  ["/playlists/[id]", async () => (await import("@/app/(app)/playlists/[id]/page")).default(params({ id: REM_PLAYLIST }))],
  ["/disconnect", async () => (await import("@/app/(app)/disconnect/page")).default()],
];

async function remGrantGone(): Promise<void> {
  await seedRem();
  const c = createClient({ url: appDatabaseUrl(), intMode: "number" });
  await c.execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [OWNER_UID as string] });
  c.close();
  await become("rem");
}

beforeAll(() => installSpotify());

describe("a dead grant on a page", () => {
  for (const [path, page] of PAGES) {
    it(`${path}: Rem's grant gone → /reconnect, which says what happened`, async () => {
      await remGrantGone();
      const o = await run(page);
      expect(o.kind === "redirect" ? new URL(o.to, "http://127.0.0.1:3000").pathname : o).toBe("/reconnect");
    });
  }

  it("no session at all: still /login", async () => {
    await seedRem();
    await become("anon");
    const o = await run(PAGES[0][1]);
    expect(o.kind === "redirect" ? new URL(o.to, "http://127.0.0.1:3000").pathname : o).toBe("/login");
  });
});
