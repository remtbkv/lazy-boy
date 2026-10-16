// T5's identity half and T9's account_id half over the app database (PLAN.md §5.1, §6.4, §12.1).
//
// The identity read's three outcomes: allowed; refused (the cookie has no uid, the uid is
// unknown, the status is not active or needs_reconnect, the epoch is stale, the sign-in is over
// 30 days old, or SIGNUPS=owner and the row is not the admin's); unavailable (the read threw,
// or the token keys failed their sentinel), which keeps the cookie and sets no uid.
// Sign-in: Spotify's account_id is the link; the invite claim itself waits for Phase 4a.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readIdentity, resolveSignIn, signedInUser, signInRedirect, signInRefusalMessage } from "@/lib/identity-read";
import { gateFromSession, gateJwt, sessionFields, signInClaims } from "@/lib/session-gate";
import { appTokenStore } from "@/lib/token-store-app";
import { expectSignupsOwnerRefusesFriend, freshAppDb, seedUser } from "./harness";

const A = "aaaaaaaaaaaa"; // the admin
const B = "bbbbbbbbbbbb"; // a friend
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const cookie = (uid: string, ep = 0, authTime = NOW_S - 60) => ({ uid, ep, auth_time: authTime });
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number> = {}) => (await db.raw().execute({ sql, args })).rows;

beforeEach(async () => {
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await appTokenStore().get(A as never); // first open: schema and sentinel
  await seedUser(db.raw(), { uid: A, status: "active", admin: true, accountId: "acct-rem", spotifyId: "rem" });
  await seedUser(db.raw(), { uid: B, status: "active", epoch: 2, accountId: "acct-b", spotifyId: "friend-old" });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T5: the identity read's three outcomes", () => {
  it("allowed: the admin's Phase 1 cookie (OWNER_UID, epoch 0) still signs in, so Rem stays signed in", async () => {
    expect(await readIdentity(cookie(A))).toEqual({ kind: "allowed", uid: A, admin: true });
  });

  it("refused: no uid, an unknown uid, a stale epoch, a 31-day-old sign-in", async () => {
    expect(await readIdentity({ auth_time: NOW_S })).toEqual({ kind: "refused", reason: "no-uid" });
    expect(await readIdentity(cookie("cccccccccccc"))).toEqual({ kind: "refused", reason: "unknown" });
    vi.stubEnv("SIGNUPS", "invite");
    expect(await readIdentity(cookie(B, 1))).toEqual({ kind: "refused", reason: "epoch" });
    expect(await readIdentity(cookie(B, 2, NOW_S - 31 * 86_400))).toEqual({ kind: "refused", reason: "expired" });
    expect(await readIdentity(cookie(B, 2))).toEqual({ kind: "allowed", uid: B, admin: false });
  });

  it("refused: every status but active and needs_reconnect", async () => {
    vi.stubEnv("SIGNUPS", "invite");
    for (const status of ["disabled", "deleting", "deleted", "revoked", "removed", "invited", "provisioning"]) {
      await q("UPDATE users SET status = :s WHERE uid = :u", { s: status, u: B });
      expect(await readIdentity(cookie(B, 2)), status).toEqual({ kind: "refused", reason: "status" });
    }
    await q("UPDATE users SET status = 'needs_reconnect' WHERE uid = :u", { u: B });
    expect((await readIdentity(cookie(B, 2))).kind).toBe("allowed");
  });

  it("refused: SIGNUPS=owner (and unset) refuses a friend's live cookie whatever the row says", async () => {
    await expectSignupsOwnerRefusesFriend(readIdentity, { admin: cookie(A), friend: cookie(B, 2) });
  });

  it("unavailable: the read throwing keeps the cookie unchanged and sets no uid", async () => {
    vi.stubEnv("APP_DATABASE_URL", "libsql://not-allowed.example.invalid");
    const v = await readIdentity(cookie(A));
    expect(v).toEqual({ kind: "unavailable" });
    const t = cookie(A);
    expect(gateJwt(t, v)).toBe(t);
    expect(sessionFields(v)).toEqual({ idUnavailable: true });
    expect(gateFromSession({ expires: "", idUnavailable: true } as never)).toEqual({ kind: "unavailable" });
  });

  it("unavailable: a key that fails its sentinel refuses to serve and leaves every user active", async () => {
    vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
    expect(await readIdentity(cookie(A))).toEqual({ kind: "unavailable" });
    expect((await q("SELECT status FROM users ORDER BY uid")).map((r) => r.status)).toEqual(["active", "active"]);
  });
});

describe("T9: sign-in by account_id", () => {
  it("a profile without account_id is refused, and nothing is keyed on its id", async () => {
    const before = await q("SELECT * FROM users ORDER BY uid");
    for (const p of [{ id: "rem" }, { id: "rem", account_id: "" }, { id: "rem", account_id: 42 }]) {
      const o = await resolveSignIn(p);
      expect(o).toEqual({ kind: "refused", code: "NoAccountId" });
      expect(signInRedirect(o as never)).toBe("/login?error=NoAccountId");
    }
    expect(await q("SELECT * FROM users ORDER BY uid")).toEqual(before);
  });

  it("a returning user is found by account_id after their Spotify id changed", async () => {
    vi.stubEnv("SIGNUPS", "invite");
    const o = await resolveSignIn({ id: "friend-new", account_id: "acct-b" }, 1_000);
    expect(o.kind === "allowed" && o.user.uid).toBe(B);
    expect(await q("SELECT spotify_id, last_sign_in FROM users WHERE uid = :u", { u: B })).toEqual([
      { spotify_id: "friend-new", last_sign_in: 1_000 },
    ]);
  });

  it("a deleted user is told when; deleting too; disabled is told to ask Rem", async () => {
    const day = Date.UTC(2026, 9, 20, 15);
    await q("UPDATE users SET status = 'deleted', status_at = :at WHERE uid = :u", { at: day, u: B });
    const o = await resolveSignIn({ id: "friend-old", account_id: "acct-b" });
    expect(o).toEqual({ kind: "refused", code: "AccountDeleted", deletedOn: "2026-10-20" });
    expect(signInRedirect(o as never)).toBe("/login?error=AccountDeleted&on=2026-10-20");
    expect(signInRefusalMessage("AccountDeleted", "2026-10-20")).toBe(
      "This account was deleted on 2026-10-20. Ask Rem for a new invite.",
    );
    await q("UPDATE users SET status = 'deleting' WHERE uid = :u", { u: B });
    expect((await resolveSignIn({ id: "friend-old", account_id: "acct-b" })).kind).toBe("refused");
    await q("UPDATE users SET status = 'disabled' WHERE uid = :u", { u: B });
    expect(await resolveSignIn({ id: "friend-old", account_id: "acct-b" })).toEqual({
      kind: "refused",
      code: "AccountDisabled",
    });
  });

  it("a dead grant's fresh consent returns the user to active, by compare-and-set", async () => {
    vi.stubEnv("SIGNUPS", "invite");
    for (const s of ["needs_reconnect", "revoked"]) {
      await q("UPDATE users SET status = :s, status_at = 1 WHERE uid = :u", { s, u: B });
      expect((await resolveSignIn({ id: "friend-old", account_id: "acct-b" }, 9_000)).kind, s).toBe("allowed");
      expect(await q("SELECT status, status_at FROM users WHERE uid = :u", { u: B })).toEqual([{ status: "active", status_at: 9_000 }]);
    }
  });

  it("SIGNUPS=owner refuses a friend at sign-in too, whatever the row says", async () => {
    expect(await resolveSignIn({ id: "friend-old", account_id: "acct-b" })).toEqual({ kind: "refused", code: "AccessDenied" });
    expect((await resolveSignIn({ id: "rem", account_id: "acct-rem" })).kind).toBe("allowed");
  });

  it("the admin's first Phase 2 sign-in binds his account_id once; nobody else can bind", async () => {
    await q("UPDATE users SET account_id = NULL WHERE uid = :u", { u: A });
    expect(await resolveSignIn({ id: "friend-x", account_id: "acct-x" })).toEqual({ kind: "refused", code: "AccessDenied" });
    const o = await resolveSignIn({ id: "rem", account_id: "acct-rem2" });
    expect(o.kind === "allowed" && o.user.uid).toBe(A);
    expect(await resolveSignIn({ id: "rem", account_id: "acct-other" })).toEqual({ kind: "refused", code: "AccessDenied" });
    expect((await q("SELECT account_id FROM users WHERE uid = :u", { u: A }))[0].account_id).toBe("acct-rem2");
  });

  it("the cookie's claims come from the row: its uid and epoch, auth_time now", async () => {
    expect(signInClaims({ uid: B, sessionEpoch: 2 }, NOW)).toEqual({ uid: B, ep: 2, auth_time: NOW_S });
    expect(signInClaims(null, NOW)).toBeNull();
    expect(signInClaims({ uid: "not-a-uid", sessionEpoch: 0 }, NOW)).toBeNull();
  });
});

describe("the jwt callback's sign-in row", () => {
  it("is the row resolveSignIn admitted; nothing for a friend under SIGNUPS=owner or a dead row", async () => {
    expect((await signedInUser({ id: "rem", account_id: "acct-rem" }))?.uid).toBe(A);
    expect(await signedInUser({ id: "friend-old", account_id: "acct-b" })).toBeNull();
    vi.stubEnv("SIGNUPS", "invite");
    expect((await signedInUser({ id: "friend-old", account_id: "acct-b" }))?.uid).toBe(B);
    await q("UPDATE users SET status = 'deleting' WHERE uid = :u", { u: B });
    expect(await signedInUser({ id: "friend-old", account_id: "acct-b" })).toBeNull();
    expect(await signedInUser({ id: "rem" })).toBeNull();
  });
});
