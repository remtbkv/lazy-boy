// The invite claim through the real Auth.js callback (PLAN.md §5.1, §12.1; PHASE4A.md §4 item 5):
// with `src/lib/owner.ts` gone, an allowlisted friend whose request Rem approved signs in with the
// request cookie /join left and gets their own uid, row and token row, under SIGNUPS=invite only.
// T9 proves the claim's rules on resolveSignIn; this proves nothing in front of it refuses them.
import { createClient } from "@libsql/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));

import { appDatabaseUrl, createJoinRequest } from "@/lib/app-db";
import { REQUEST_COOKIE, signRequestCookie } from "@/lib/request-cookie";
import { ctx } from "./authz-context";
import { become, installSpotify, seedRem } from "./authz-harness";
import { oauthCallback } from "./authz-registry";
import { seedApprovedInvite } from "./harness";

const A = "aaaaaaaaaaaa"; // the uid Rem's approval of friend A's request made
const app = () => createClient({ url: appDatabaseUrl(), intMode: "number" });

beforeAll(() => installSpotify());
beforeEach(async () => {
  await seedRem();
  const c = app();
  await c.execute("DELETE FROM requests");
  // seedRem leaves friend A connected (the authz harness's friends, lane 15); here A has not
  // claimed yet, so their rows go and Rem's approval re-creates A as an invite.
  await c.execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [A] });
  await c.execute({ sql: "DELETE FROM users WHERE uid = ?", args: [A] });
  c.close();
  await become("anon");
});
afterEach(() => vi.unstubAllEnvs());

async function approvedRequestFor(uid: string): Promise<string> {
  vi.stubEnv("SIGNUPS", "invite");
  const r = await createJoinRequest({ email: "a@example.test", name: "", agreed: true, now: Date.now() });
  if (!r.ok) throw new Error(r.reason);
  const c = app();
  await seedApprovedInvite(c, { rid: r.id, uid, invitedAt: Date.now() - 3_600_000 });
  c.close();
  return r.id;
}

describe("the claim through auth.ts", () => {
  it("friend A, allowlisted, with the request cookie and SIGNUPS=invite: their own uid, row and token", async () => {
    const rid = await approvedRequestFor(A);
    ctx.cookies.set(REQUEST_COOKIE, signRequestCookie(rid, Date.now()));
    const res = await oauthCallback("A");
    expect(res.headers.get("location") ?? "", "the callback's redirect").not.toMatch(/error=/);
    const c = app();
    const [u] = (await c.execute({ sql: "SELECT account_id, spotify_id, status FROM users WHERE uid = ?", args: [A] })).rows;
    const tokens = (await c.execute({ sql: "SELECT count(*) AS n FROM user_tokens WHERE uid = ?", args: [A] })).rows[0].n;
    c.close();
    expect(u).toMatchObject({ account_id: "a-account", spotify_id: "friend-a-spotify", status: "active" });
    expect(tokens).toBe(1);
  });

  it("the same under SIGNUPS=owner: refused, the invite untouched", async () => {
    const rid = await approvedRequestFor(A);
    vi.stubEnv("SIGNUPS", "owner");
    ctx.cookies.set(REQUEST_COOKIE, signRequestCookie(rid, Date.now()));
    const res = await oauthCallback("A");
    expect(res.headers.get("location") ?? "").toMatch(/error=/);
    const c = app();
    const [u] = (await c.execute({ sql: "SELECT account_id, status FROM users WHERE uid = ?", args: [A] })).rows;
    c.close();
    expect(u).toMatchObject({ account_id: null, status: "invited" });
  });

  it("an allowlisted account with no row and no cookie: refused, nothing written", async () => {
    vi.stubEnv("SIGNUPS", "invite");
    const res = await oauthCallback("B");
    expect(res.headers.get("location") ?? "").toMatch(/error=/);
    const c = app();
    const n = (await c.execute("SELECT count(*) AS n FROM users WHERE account_id = 'b-account'")).rows[0].n;
    c.close();
    expect(n).toBe(0);
  });
});
