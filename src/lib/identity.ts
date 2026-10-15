// Who a request is (docs/multi-user/PLAN.md §4.4, §5.1, §6.2 layer 2).
//
// A user is named everywhere by a random 12-character base32 uid: never reused, nothing personal
// in it, so it can sit raw in a cache key, an ETag or a browser storage key. The branded `Uid`
// type is how the code keeps a uid taken from request input (a path, a query, a body) away from
// anything that reads user data: a plain string does not compile where a `Uid` is wanted, and
// `mintUid` below is the only cast. Who may import it is pinned by tests/isolation/static.test.ts
// (S2): the session gate, and later the cron's claim and the scripts' `--user` helper.
//
// No database here. Phase 1 has one user and no app database, so the identity lookup is
// `ownerOnlyLookup` over the `OWNER_UID` constant; Phase 2 swaps in the app-database read with
// the same signature, and `checkIdentity`'s three outcomes stay as they are.
import { randomBytes } from "node:crypto";

declare const brand: unique symbol;
export type Uid = string & { readonly [brand]: "Uid" };

const UID_RE = /^[a-z2-7]{12}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function isUidShape(s: unknown): s is string {
  return typeof s === "string" && UID_RE.test(s);
}

/** A fresh uid: 60 random bits as 12 base32 characters. */
export function newUid(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out;
}

/** The only `as Uid` in the codebase. Throws on anything not uid-shaped. */
export function mintUid(s: string): Uid {
  if (!isUidShape(s)) throw new Error("not a uid");
  return s as Uid;
}

/** Rem's uid in Phase 1: a Production constant, not a secret (§11.4). Null when unset or
 *  malformed, which refuses every sign-in rather than minting a cookie for no one. */
export function ownerUid(): string | null {
  const v = process.env.OWNER_UID;
  return isUidShape(v) ? v : null;
}

/** A session lasts 30 days from its sign-in, enforced by `auth_time` (§5.4): Auth.js re-issues
 *  the cookie's own expiry on every session read, so that expiry bounds nothing. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
// A cookie stamped further ahead than this is forged or from a broken clock.
const FUTURE_SKEW_S = 5 * 60;

export type SessionClaims = { uid?: unknown; ep?: unknown; auth_time?: unknown };
export type IdentityRow = { status: string; sessionEpoch: number; isAdmin: boolean };
export type IdentityLookup = (uid: string) => Promise<IdentityRow | null>;
export type RefuseReason = "no-uid" | "expired" | "unknown" | "status" | "epoch" | "signups";
export type IdentityVerdict =
  | { kind: "allowed"; uid: Uid; admin: boolean }
  | { kind: "refused"; reason: RefuseReason }
  | { kind: "unavailable" };

// needs_reconnect still signs in: the page gates send a dead grant to /login (§5.4).
const SIGNED_IN_STATUSES = new Set(["active", "needs_reconnect"]);

/** The check every request makes before it can read user data (§5.1). Refused signs the
 *  request out; unavailable (the lookup threw) keeps the cookie but yields no uid, so nothing
 *  reads user data and the caller answers a retryable error. */
export async function checkIdentity(
  claims: SessionClaims,
  lookup: IdentityLookup,
  opts: { now: number; signups: "owner" | "invite" },
): Promise<IdentityVerdict> {
  if (!isUidShape(claims.uid)) return { kind: "refused", reason: "no-uid" };
  const nowS = Math.floor(opts.now / 1000);
  const at = claims.auth_time;
  if (typeof at !== "number" || nowS - at > SESSION_MAX_AGE_S || at - nowS > FUTURE_SKEW_S) {
    return { kind: "refused", reason: "expired" };
  }
  let row: IdentityRow | null;
  try {
    row = await lookup(claims.uid);
  } catch {
    return { kind: "unavailable" };
  }
  if (!row) return { kind: "refused", reason: "unknown" };
  if (!SIGNED_IN_STATUSES.has(row.status)) return { kind: "refused", reason: "status" };
  if (claims.ep !== row.sessionEpoch) return { kind: "refused", reason: "epoch" };
  if (opts.signups === "owner" && !row.isAdmin) return { kind: "refused", reason: "signups" };
  return { kind: "allowed", uid: mintUid(claims.uid), admin: row.isAdmin };
}

/** Phase 1's lookup: the owner alone, active, at epoch 0, admin (§11.4). */
export function ownerOnlyLookup(owner: string | null): IdentityLookup {
  return async (uid) =>
    owner && uid === owner ? { status: "active", sessionEpoch: 0, isAdmin: true } : null;
}

/** `SIGNUPS`: "owner" (the default, Phases 1-3) admits the admin alone whatever the rows say. */
export function signupsMode(): "owner" | "invite" {
  return process.env.SIGNUPS === "invite" ? "invite" : "owner";
}
