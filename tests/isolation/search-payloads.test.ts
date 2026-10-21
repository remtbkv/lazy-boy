// T7's server half (PLAN.md §6.2 layer 6, §6.4) with two users through the real search routes:
// A and B with equal versions get different ETags, B sending A's ETag gets 200 and B's own body,
// every body is `private, no-store` and names its user as `u`, and a refused caller gets the
// signed-out 401 that tells the browser to clear its stores. The gate is stubbed to a chosen uid
// and forUser to Phase 2's mapping (each uid its own database), since Phase 1 knows one user.
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Uid } from "@/lib/identity";

const who = vi.hoisted(() => ({ uid: null as string | null }));

vi.mock("@/lib/require-user", async () => {
  const { SIGNED_OUT_HEADER } = await import("@/lib/user-storage");
  return {
    requireRouteUser: async () =>
      who.uid
        ? { uid: who.uid, admin: false }
        : Response.json({ error: "unauthorized" }, { status: 401, headers: { [SIGNED_OUT_HEADER]: "1" } }),
  };
});
vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return { ...real, forUser: (uid: Uid) => real.forUserAt(uid, `s-${uid}`) };
});

import { forUserAt } from "@/lib/db";
import { isSignedOutResponse } from "@/lib/user-storage";
import { A, B, seedUser, useUserFiles } from "./user-dbs";

const ROUTES = {
  library: async () => (await import("@/app/api/search/library/route")).GET,
  history: async () => (await import("@/app/api/search/history/route")).GET,
};

async function get(kind: keyof typeof ROUTES, as: Uid | null, etag?: string): Promise<Response> {
  who.uid = as;
  const headers: Record<string, string> = etag ? { "if-none-match": etag } : {};
  return (await ROUTES[kind]())(new Request(`http://127.0.0.1:3000/api/search/${kind}`, { headers }));
}

beforeAll(async () => {
  useUserFiles();
  for (const [uid, tag] of [[A, "A"], [B, "B"]] as const) {
    await seedUser(forUserAt(uid, `s-${uid}`), tag);
    const c = createClient({ url: (process.env.STORE_URL_TEMPLATE as string).replaceAll("{db}", `s-${uid}`) });
    await c.executeMultiple(`
      UPDATE meta SET value = '50' WHERE key = 'write_seq';
      UPDATE meta SET value = '20' WHERE key = 'library_seq';
      DELETE FROM meta WHERE key = 'slow_seq_pub';`);
    c.close();
  }
});

describe("T7: the search payloads with two users", () => {
  for (const kind of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
    it(`${kind}: equal versions, different ETags, each naming its user`, async () => {
      const ra = await get(kind, A);
      const rb = await get(kind, B);
      const [ta, tb] = [ra.headers.get("etag"), rb.headers.get("etag")];
      expect(ta).toContain(A);
      expect(tb).toContain(B);
      expect(ta).not.toBe(tb);
      const [ba, bb] = [(await ra.json()) as { v: string; u: string }, (await rb.json()) as { v: string; u: string }];
      expect(ba.v).toBe(bb.v); // the same version: only the uid (and epoch) tells them apart
      expect([ba.u, bb.u]).toEqual([A, B]);
    });

    it(`${kind}: B sending A's ETag gets 200 and B's own body; B's own ETag gets 304`, async () => {
      const ta = (await get(kind, A)).headers.get("etag")!;
      const res = await get(kind, B, ta);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("B-only");
      expect(text).not.toContain("A-only");
      expect(JSON.parse(text).u).toBe(B);
      const tb = res.headers.get("etag")!;
      expect((await get(kind, B, tb)).status).toBe(304);
      expect((await get(kind, B, `W/${tb}`)).status).toBe(304);
    });

    it(`${kind}: private, no-store, on the 200 and on the 304`, async () => {
      const res = await get(kind, A);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const again = await get(kind, A, res.headers.get("etag")!);
      expect(again.headers.get("cache-control")).toBe("private, no-store");
    });

    it(`${kind}: a refused caller gets the signed-out 401 and no body of anyone's`, async () => {
      const res = await get(kind, null);
      expect(res.status).toBe(401);
      expect(isSignedOutResponse(res)).toBe(true);
      const text = await res.text();
      expect(text).not.toMatch(/[AB]-only/);
    });
  }
});
