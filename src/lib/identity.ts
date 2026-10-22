// Who a request is (docs/multi-user/PLAN.md §4.4, §5.1, §6.2 layer 2).
//
// A user is named everywhere by a random 12-character base32 uid: never reused, nothing personal
// in it, so it can sit raw in a cache key, an ETag or a browser storage key. The branded `Uid`
// type is how the code keeps a uid taken from request input (a path, a query, a body) away from
// anything that reads user data: a plain string does not compile where a `Uid` is wanted, and
// `mintUid` below is the only cast. Who may import it is pinned by tests/isolation/static.test.ts
// (S2): the session gate, and later the cron's claim and the scripts' `--user` helper.
//
// No database here: the lookup is a parameter. Phase 2's is the app-database read
// (identity-read.ts, `appIdentityLookup`), which replaced Phase 1's owner-only constant with
// the same signature; `checkIdentity`'s three outcomes stay as they are.
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

/** Rem's uid: a Production constant, not a secret (§11.4), the uid of the admin's `users` row.
 *  phase1Owner() below and the runtime's copy of his plaintext token row use it. Null when
 *  unset or malformed. */
export function ownerUid(): string | null {
  const v = process.env.OWNER_UID;
  return isUidShape(v) ? v : null;
}

/** Rem's uid as a Uid, for the paths that act for him with no session in Phase 1: the cron and
 *  the daily chores (Phase 3's claim replaces this, §7.2), the sign-in (Phase 2's users row),
 *  and the app-wide rows that live in his database until Phase 2. Null when OWNER_UID is unset
 *  or malformed. Who may import it is pinned by tests/isolation/static.test.ts (S2). */
export function phase1Owner(): Uid | null {
  const o = ownerUid();
  return o ? mintUid(o) : null;
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

/** `SIGNUPS`: "owner" (the default, Phases 1-3) admits the admin alone whatever the rows say. */
export function signupsMode(): "owner" | "invite" {
  return process.env.SIGNUPS === "invite" ? "invite" : "owner";
}
