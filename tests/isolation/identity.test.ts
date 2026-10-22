// Phase 1 identity (PLAN.md §5.1, §6.2 layer 2, T5's identity half): the cookie names a uid, and
// every later request checks it before anything can read user data. Three outcomes: allowed,
// refused (signs the request out), unavailable (keeps the cookie, sets no uid, so nothing reads).
import { describe, expect, it } from "vitest";
import {
  checkIdentity,
  isUidShape,
  mintUid,
  newUid,
  ownerOnlyLookup,
  SESSION_MAX_AGE_S,
  type IdentityLookup,
} from "@/lib/identity";
import { gateFromSession, gateJwt, sessionFields, signInClaims } from "@/lib/session-gate";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const NOW = 1_800_000_000_000;
const NOW_S = Math.floor(NOW / 1000);
const fresh = (uid: string, ep = 0) => ({ uid, ep, auth_time: NOW_S - 60 });

const rows: Record<string, { status: string; sessionEpoch: number; isAdmin: boolean }> = {
  [A]: { status: "active", sessionEpoch: 0, isAdmin: true },
  [B]: { status: "active", sessionEpoch: 3, isAdmin: false },
};
const lookup: IdentityLookup = async (uid) => rows[uid] ?? null;
const opts = { now: NOW, signups: "invite" as const };

describe("uids", () => {
  it("newUid is 12 base32 characters and does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const u = newUid();
      expect(isUidShape(u)).toBe(true);
      seen.add(u);
    }
    expect(seen.size).toBe(2000);
  });

  it("mintUid refuses anything that is not uid-shaped", () => {
    expect(mintUid(A)).toBe(A);
    for (const bad of ["", "AAAAAAAAAAAA", "aaaaaaaaaaa", "aaaaaaaaaaaaa", "aaaaaaaaaaa1", "../../etc/pa"]) {
      expect(() => mintUid(bad)).toThrow();
    }
  });
});

describe("checkIdentity", () => {
  it("allows a live cookie for a known, active user at the current epoch", async () => {
    expect(await checkIdentity(fresh(A), lookup, opts)).toEqual({ kind: "allowed", uid: A, admin: true });
    expect(await checkIdentity(fresh(B, 3), lookup, opts)).toEqual({ kind: "allowed", uid: B, admin: false });
  });

  it("refuses a cookie with no uid: every cookie minted before Phase 1", async () => {
    let called = 0;
    const counting: IdentityLookup = async (u) => (called++, lookup(u));
    expect(await checkIdentity({ sub: "random", auth_time: NOW_S } as never, counting, opts)).toEqual({
      kind: "refused",
      reason: "no-uid",
    });
    expect(called).toBe(0);
  });

  it("refuses a malformed uid without a lookup", async () => {
    let called = 0;
    const counting: IdentityLookup = async (u) => (called++, lookup(u));
    const v = await checkIdentity({ ...fresh(A), uid: "AAAAAAAAAAAA" }, counting, opts);
    expect(v).toEqual({ kind: "refused", reason: "no-uid" });
    expect(called).toBe(0);
  });

  it("refuses an unknown uid", async () => {
    expect(await checkIdentity(fresh("cccccccccccc"), lookup, opts)).toEqual({ kind: "refused", reason: "unknown" });
  });

  it("refuses a stale epoch: sign out everywhere", async () => {
    expect(await checkIdentity(fresh(B, 2), lookup, opts)).toEqual({ kind: "refused", reason: "epoch" });
  });

  it("refuses a sign-in older than 30 days, and a cookie with no auth_time", async () => {
    const old = { uid: A, ep: 0, auth_time: NOW_S - SESSION_MAX_AGE_S - 1 };
    expect(await checkIdentity(old, lookup, opts)).toEqual({ kind: "refused", reason: "expired" });
    const edge = { uid: A, ep: 0, auth_time: NOW_S - SESSION_MAX_AGE_S + 1 };
    expect((await checkIdentity(edge, lookup, opts)).kind).toBe("allowed");
    expect(await checkIdentity({ uid: A, ep: 0 }, lookup, opts)).toEqual({ kind: "refused", reason: "expired" });
  });

  it("refuses an auth_time in the future (a forged or clock-skewed cookie)", async () => {
    const future = { uid: A, ep: 0, auth_time: NOW_S + 3600 };
    expect(await checkIdentity(future, lookup, opts)).toEqual({ kind: "refused", reason: "expired" });
  });

  it("refuses every status but active and needs_reconnect", async () => {
    for (const status of ["disabled", "deleting", "deleted", "removed", "revoked", "dormant", "invited", "provisioning"]) {
      const l: IdentityLookup = async () => ({ status, sessionEpoch: 0, isAdmin: false });
      expect(await checkIdentity(fresh(B, 0), l, opts)).toEqual({ kind: "refused", reason: "status" });
    }
    const nr: IdentityLookup = async () => ({ status: "needs_reconnect", sessionEpoch: 0, isAdmin: false });
    expect((await checkIdentity(fresh(B, 0), nr, opts)).kind).toBe("allowed");
  });

  it("SIGNUPS=owner refuses a non-admin's live cookie and keeps the admin's", async () => {
    const owner = { now: NOW, signups: "owner" as const };
    expect(await checkIdentity(fresh(B, 3), lookup, owner)).toEqual({ kind: "refused", reason: "signups" });
    expect((await checkIdentity(fresh(A), lookup, owner)).kind).toBe("allowed");
  });

  it("a lookup that throws is unavailable: no uid, no refusal", async () => {
    const down: IdentityLookup = async () => {
      throw new Error("store down");
    };
    expect(await checkIdentity(fresh(A), down, opts)).toEqual({ kind: "unavailable" });
  });

  it("ownerOnlyLookup (Phase 1) knows the owner alone, at epoch 0, as admin", async () => {
    const l = ownerOnlyLookup(A);
    expect(await l(A)).toEqual({ status: "active", sessionEpoch: 0, isAdmin: true });
    expect(await l(B)).toBeNull();
    expect(await ownerOnlyLookup(null)(A)).toBeNull();
  });
});

describe("session gate (the jwt and session callbacks' decisions)", () => {
  it("signInClaims stamps the owner uid, epoch 0 and auth_time; none without an owner uid", () => {
    expect(signInClaims(A, NOW)).toEqual({ uid: A, ep: 0, auth_time: NOW_S });
    expect(signInClaims(null, NOW)).toBeNull();
    expect(signInClaims("not-a-uid", NOW)).toBeNull();
  });

  it("gateJwt: refused signs out (null); allowed and unavailable keep the cookie unchanged", () => {
    const token = { ...fresh(A), name: "x" };
    expect(gateJwt(token, { kind: "refused", reason: "epoch" })).toBeNull();
    expect(gateJwt(token, { kind: "allowed", uid: mintUid(A), admin: true })).toBe(token);
    expect(gateJwt(token, { kind: "unavailable" })).toBe(token);
  });

  it("sessionFields: the uid goes on the session only when allowed", () => {
    expect(sessionFields({ kind: "allowed", uid: mintUid(A), admin: true })).toEqual({ uid: A, admin: true });
    expect(sessionFields({ kind: "unavailable" })).toEqual({ idUnavailable: true });
    expect(sessionFields({ kind: "refused", reason: "unknown" })).toEqual({});
  });

  it("gateFromSession: allowed only with a uid and a live grant; unavailable keeps its retry; no session refuses", () => {
    expect(gateFromSession(null)).toEqual({ kind: "refused" });
    expect(gateFromSession({ user: {}, expires: "" })).toEqual({ kind: "refused" });
    expect(gateFromSession({ user: {}, expires: "", idUnavailable: true })).toEqual({ kind: "unavailable" });
    expect(gateFromSession({ user: {}, expires: "", uid: "not-a-uid" })).toEqual({ kind: "refused" });
    expect(gateFromSession({ user: {}, expires: "", uid: A, admin: true })).toEqual({
      kind: "allowed",
      gate: { uid: A, admin: true },
    });
    // A session whose Spotify grant is gone (Log out, invalid_grant) is refused on every entry
    // point, as the pages already refused it (PLAN §5.4; AUTHZ.md F2): it used to keep reading
    // search, history and tasks, a copied cookie included.
    expect(
      gateFromSession({ user: {}, expires: "", uid: A, admin: false, error: "RefreshAccessTokenError" }),
    ).toEqual({ kind: "refused" });
  });
});
