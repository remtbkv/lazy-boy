// T9's claim half (PLAN.md §5.1, §6.4, §12.1, as RULINGS Oct 15 12:46 PM changes it): sign-up is
// a request form; Rem approves a request from the Mac, which makes an `invited` users row; the
// friend's sign-in claims it with the signed request cookie the form (or Rem's join link) left.
// Development mode returns no e-mail from /v1/me, so the cookie is the only thing that names the
// request; the claim binds the signing-in account_id to that request's invite once, by
// compare-and-set.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJoinRequest } from "@/lib/app-db";
import { resolveSignIn, signedInUser } from "@/lib/identity-read";
import { REQUEST_COOKIE_TTL_S, signRequestCookie, verifyRequestCookie } from "@/lib/request-cookie";
import { appTokenStore } from "@/lib/token-store-app";
import { freshAppDb, seedApprovedInvite, seedUser } from "./harness";

const ADMIN = "aaaaaaaaaaaa";
const X = "xxxxxxxxxxxx"; // the uid Rem's approval of X's request made
const Y = "yyyyyyyyyyyy"; // the uid Rem's approval of Y's request made
const NOW = Date.now();
const DAY = 86_400_000;
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number> = {}) => (await db.raw().execute({ sql, args })).rows;
const profile = (who: string) => ({ id: `sp-${who}`, account_id: `acct-${who}` });

beforeEach(async () => {
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "invite");
  vi.stubEnv("AUTH_SECRET", "test-auth-secret-0123456789");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await appTokenStore().get(ADMIN as never); // first open: schema and sentinel
  await seedUser(db.raw(), { uid: ADMIN, status: "active", admin: true, accountId: "acct-rem", spotifyId: "rem" });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function request(email: string): Promise<string> {
  const r = await createJoinRequest({ email, name: "", agreed: true, now: NOW });
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

describe("T9: the claim", () => {
  it("a request alone signs nobody in: pending, it is AccessDenied and writes nothing", async () => {
    const rid = await request("x@example.com");
    expect(await resolveSignIn(profile("x"), NOW, rid)).toEqual({ kind: "refused", code: "AccessDenied" });
    expect(await q("SELECT uid FROM users WHERE account_id = 'acct-x'")).toEqual([]);
    expect((await q("SELECT status FROM requests WHERE id = :r", { r: rid }))[0].status).toBe("pending");
  });

  it("an approved request is claimed by the account that signs in with its cookie, once", async () => {
    const rid = await request("x@example.com");
    await seedApprovedInvite(db.raw(), { rid, uid: X, invitedAt: NOW - DAY });
    const o = await resolveSignIn(profile("x"), NOW, rid);
    expect(o.kind).toBe("allowed");
    expect(o.kind === "allowed" && o.user.uid).toBe(X);
    const [u] = await q("SELECT account_id, spotify_id, status, claimed_at, terms_version, terms_accepted_at FROM users WHERE uid = :u", { u: X });
    expect(u).toMatchObject({ account_id: "acct-x", spotify_id: "sp-x", status: "active", claimed_at: NOW });
    expect(u.terms_version).toBeTruthy();
    expect(u.terms_accepted_at).toBe(NOW);
    expect((await q("SELECT status FROM requests WHERE id = :r", { r: rid }))[0].status).toBe("claimed");
    // The jwt callback's read finds the claimed row by account_id.
    expect((await signedInUser(profile("x")))?.uid).toBe(X);

    // A second account with the same cookie finds no invite left: claimed once.
    expect(await resolveSignIn(profile("z"), NOW, rid)).toEqual({ kind: "refused", code: "AccessDenied" });
    expect((await q("SELECT account_id FROM users WHERE uid = :u", { u: X }))[0].account_id).toBe("acct-x");
    expect(await q("SELECT uid FROM users WHERE account_id = 'acct-z'")).toEqual([]);
  });

  it("the users row's own compare-and-set: an invite already bound stays bound even if its request still reads approved", async () => {
    // The state an app-database restore or a half-applied manual fix could leave (§12.5).
    const rid = await request("x@example.com");
    await seedApprovedInvite(db.raw(), { rid, uid: X, invitedAt: NOW - DAY });
    await q("UPDATE users SET account_id = 'acct-x', status = 'active' WHERE uid = :u", { u: X });
    expect(await resolveSignIn(profile("z"), NOW, rid)).toEqual({ kind: "refused", code: "AccessDenied" });
    await q("UPDATE users SET status = 'invited' WHERE uid = :u", { u: X });
    expect(await resolveSignIn(profile("z"), NOW, rid)).toEqual({ kind: "refused", code: "AccessDenied" });
    expect((await q("SELECT account_id FROM users WHERE uid = :u", { u: X }))[0].account_id).toBe("acct-x");
    // And a row not yet provisioned (a crashed approval) is no invite, whatever its request says.
    await q("UPDATE users SET account_id = NULL, status = 'provisioning' WHERE uid = :u", { u: X });
    expect(await resolveSignIn(profile("z"), NOW, rid)).toEqual({ kind: "refused", code: "AccessDenied" });
    expect((await q("SELECT status, account_id FROM users WHERE uid = :u", { u: X }))[0]).toMatchObject({ status: "provisioning", account_id: null });
  });

  it("an invite whose request does not read approved is not claimed, whatever the users row says", async () => {
    // Lane 09's review (mutant M9 survived the suite): `--approve` links the request while it is
    // still pending, then moves both rows in one batch, so an `invited` row under a pending request
    // only comes from a restore or a hand edit; the claim's own request check is what refuses it.
    const rid = await request("x@example.com");
    await seedApprovedInvite(db.raw(), { rid, uid: X, invitedAt: NOW - DAY });
    await q("UPDATE requests SET status = 'pending' WHERE id = :r", { r: rid });
    expect(await resolveSignIn(profile("x"), NOW, rid)).toEqual({ kind: "refused", code: "AccessDenied" });
    expect((await q("SELECT status, account_id FROM users WHERE uid = :u", { u: X }))[0]).toMatchObject({ status: "invited", account_id: null });
  });

  it("Y cannot claim X's: Y's own cookie claims Y's invite, no cookie claims nothing, and an existing user never claims", async () => {
    const rx = await request("x@example.com");
    const ry = await request("y@example.com");
    await seedApprovedInvite(db.raw(), { rid: rx, uid: X, invitedAt: NOW - DAY });
    await seedApprovedInvite(db.raw(), { rid: ry, uid: Y, invitedAt: NOW - DAY });

    expect(await resolveSignIn(profile("y"), NOW, null)).toEqual({ kind: "refused", code: "AccessDenied" });
    const o = await resolveSignIn(profile("y"), NOW, ry);
    expect(o.kind === "allowed" && o.user.uid).toBe(Y);
    expect((await q("SELECT status, account_id FROM users WHERE uid = :u", { u: X }))[0]).toMatchObject({ status: "invited", account_id: null });

    // Y, now a user, signs in again carrying X's cookie: Y's own row wins, X's invite is untouched.
    const again = await resolveSignIn(profile("y"), NOW, rx);
    expect(again.kind === "allowed" && again.user.uid).toBe(Y);
    expect((await q("SELECT status, account_id FROM users WHERE uid = :u", { u: X }))[0]).toMatchObject({ status: "invited", account_id: null });
    expect((await q("SELECT status FROM requests WHERE id = :r", { r: rx }))[0].status).toBe("approved");

    // And X still claims X's.
    const ox = await resolveSignIn(profile("x"), NOW, rx);
    expect(ox.kind === "allowed" && ox.user.uid).toBe(X);
  });

  it("the admin carrying a friend's cookie signs in as the admin and claims nothing", async () => {
    const rx = await request("x@example.com");
    await seedApprovedInvite(db.raw(), { rid: rx, uid: X, invitedAt: NOW - DAY });
    const o = await resolveSignIn({ id: "rem", account_id: "acct-rem" }, NOW, rx);
    expect(o.kind === "allowed" && o.user.uid).toBe(ADMIN);
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: X }))[0].status).toBe("invited");
  });

  it("SIGNUPS=owner refuses the claim and writes nothing", async () => {
    const rx = await request("x@example.com");
    await seedApprovedInvite(db.raw(), { rid: rx, uid: X, invitedAt: NOW - DAY });
    for (const mode of ["", "owner"]) {
      vi.stubEnv("SIGNUPS", mode);
      expect(await resolveSignIn(profile("x"), NOW, rx)).toEqual({ kind: "refused", code: "AccessDenied" });
    }
    expect((await q("SELECT status, account_id FROM users WHERE uid = :u", { u: X }))[0]).toMatchObject({ status: "invited", account_id: null });
  });

  it("an invite older than 14 days cannot be claimed", async () => {
    const rx = await request("x@example.com");
    await seedApprovedInvite(db.raw(), { rid: rx, uid: X, invitedAt: NOW - 15 * DAY });
    expect(await resolveSignIn(profile("x"), NOW, rx)).toEqual({ kind: "refused", code: "AccessDenied" });
  });
});

describe("the request cookie: signed, short-lived, bound to one request", () => {
  const S = "test-auth-secret-0123456789";
  it("round-trips and names its request", () => {
    expect(verifyRequestCookie(signRequestCookie("abcdefghijkl", NOW, S), NOW, S)).toBe("abcdefghijkl");
  });
  it("refuses an unsigned, tampered, expired, re-pointed or foreign-secret cookie", () => {
    const c = signRequestCookie("abcdefghijkl", NOW, S);
    const [v, rid, exp, mac] = c.split(".");
    expect(verifyRequestCookie(`${v}.${rid}.${exp}`, NOW, S)).toBeNull();
    expect(verifyRequestCookie(`${v}.${rid}.${exp}.`, NOW, S)).toBeNull();
    expect(verifyRequestCookie(`${v}.mnopqrstuvwx.${exp}.${mac}`, NOW, S)).toBeNull();
    expect(verifyRequestCookie(`${v}.${rid}.${Number(exp) + 999}.${mac}`, NOW, S)).toBeNull();
    expect(verifyRequestCookie(c, NOW + REQUEST_COOKIE_TTL_S * 1000 + 1000, S)).toBeNull();
    expect(verifyRequestCookie(c, NOW, "another-secret-0123456789")).toBeNull();
    expect(verifyRequestCookie(c, NOW, "")).toBeNull();
    for (const junk of [undefined, "", "v1", "v2.abcdefghijkl.1.x", "a.b.c.d.e"]) expect(verifyRequestCookie(junk, NOW, S)).toBeNull();
  });
  it("cannot be signed without a secret", () => {
    expect(() => signRequestCookie("abcdefghijkl", NOW, "")).toThrow();
  });
});
