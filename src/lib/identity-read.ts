// Who a request or a sign-in is, read from the app database (docs/multi-user/PLAN.md §5.1, §12.1).
//
// - `appIdentityLookup` is identity.ts's `IdentityLookup` over `lazyboy-app`: the one-statement
//   read of §5.1, after the token-key check, so a deploy with a wrong key answers every request
//   "unavailable" instead of serving (§5.3). `readIdentity` runs it through `checkIdentity`
//   under the deployment's SIGNUPS, which from Phase 2 refuses every non-admin row
//   (`SIGNUPS=owner`, the one-variable freeze, §12.1). An allowed read names the user's
//   database for forUser (db.ts) from the same row; `adminStore` does the same for the paths
//   that act for the admin with no session.
// - `resolveSignIn` is the signIn callback's decision. Spotify's `account_id` is the link; its
//   mutable `id` is never keyed on (01e §5.5). The invite claim waits for Phase 4a, which
//   RULINGS Oct 15 12:46 PM turned into a request form; until then the only row a new sign-in
//   can bind is the admin's, once (§11.4 step 1).
import "server-only";
import {
  bindAdminAccount,
  findUserByAccountId,
  moveStatus,
  readIdentityRow,
  recordSignIn,
  type AppIdentityRow,
  type UserRow,
} from "@/lib/app-db";
import { forUserAt, type UserStore } from "@/lib/db";
import {
  checkIdentity,
  phase1Owner,
  signupsMode,
  type IdentityLookup,
  type IdentityVerdict,
  type SessionClaims,
} from "@/lib/identity";
import { tokenKeysReady } from "@/lib/token-keys";

export const appIdentityLookup = async (uid: string): Promise<AppIdentityRow | null> => {
  await tokenKeysReady();
  return readIdentityRow(uid);
};

/** The identity read every later request makes, with its three outcomes (§5.1). An allowed
 *  read also names the user's database for forUser (db.ts): the row's db_name, read again on
 *  every request, so a restore that moved the user reaches this process at their next one
 *  (§4.2, §12.5). */
export async function readIdentity(claims: SessionClaims, now = Date.now()): Promise<IdentityVerdict> {
  const read: { row?: AppIdentityRow | null } = {};
  const lookup: IdentityLookup = async (uid) => (read.row = await appIdentityLookup(uid));
  const v = await checkIdentity(claims, lookup, { now, signups: signupsMode() });
  if (v.kind === "allowed" && read.row) forUserAt(v.uid, read.row.dbName);
  return v;
}

/** The admin's data, for the paths that act for him with no session until Phase 3's claim
 *  (the cron, the daily chores, the health check, the store bench, the sign-in's owner
 *  guard): OWNER_UID's `users` row names his database, as a request's identity read would.
 *  Null when OWNER_UID is unset or no admin row carries it. Throws when the read does. */
export async function adminStore(): Promise<UserStore | null> {
  const uid = phase1Owner();
  if (!uid) return null;
  const row = await readIdentityRow(uid);
  return row?.isAdmin ? forUserAt(uid, row.dbName) : null;
}

export type SignInProfile = { id?: unknown; account_id?: unknown };
export type SignInRefusal = "NoAccountId" | "AccountDisabled" | "AccountDeleted" | "AccessDenied";
export type SignInOutcome =
  | { kind: "allowed"; user: UserRow }
  | { kind: "refused"; code: SignInRefusal; deletedOn?: string };

const accountIdOf = (p: SignInProfile) => (typeof p.account_id === "string" && p.account_id ? p.account_id : null);

/** The signIn callback's decision. Writes only the sign-in's own row: the admin's first
 *  binding, a dead grant's return to `active` (by compare-and-set), and `last_sign_in`. */
export async function resolveSignIn(profile: SignInProfile, now = Date.now()): Promise<SignInOutcome> {
  const aid = accountIdOf(profile);
  const sid = typeof profile.id === "string" ? profile.id : "";
  if (!aid || !sid) {
    console.error("[auth] Spotify's profile carries no account_id: refusing sign-in");
    return { kind: "refused", code: "NoAccountId" };
  }
  let user = (await findUserByAccountId(aid)) ?? (await bindAdminAccount(aid, sid, now));
  // Every refusal comes before any write. A fresh consent is what needs_reconnect and revoked
  // were waiting for; if someone else moved the row first (the deletion job), decide again on
  // what it says now.
  for (let tries = 0; ; tries++) {
    if (!user) return { kind: "refused", code: "AccessDenied" };
    if (user.status === "disabled") return { kind: "refused", code: "AccountDisabled" };
    if (user.status === "deleting" || user.status === "deleted") {
      return { kind: "refused", code: "AccountDeleted", deletedOn: new Date(user.statusAt).toISOString().slice(0, 10) };
    }
    if (signupsMode() === "owner" && !user.isAdmin) return { kind: "refused", code: "AccessDenied" };
    if (user.status === "active") break;
    if ((user.status !== "needs_reconnect" && user.status !== "revoked") || tries >= 2) {
      return { kind: "refused", code: "AccessDenied" };
    }
    if (await moveStatus(user.uid, user.status, "active", now)) {
      user = { ...user, status: "active", statusAt: now };
      break;
    }
    user = await findUserByAccountId(aid);
  }
  await recordSignIn(user.uid, sid, now);
  return { kind: "allowed", user: { ...user, spotifyId: sid } };
}

/** The jwt callback's sign-in branch: the row resolveSignIn just admitted, read again by
 *  account_id, so the cookie's uid and epoch come from the row (§5.1), never the profile. */
export async function signedInUser(profile: SignInProfile): Promise<UserRow | null> {
  const aid = accountIdOf(profile);
  const user = aid ? await findUserByAccountId(aid) : null;
  return user?.status === "active" && (user.isAdmin || signupsMode() === "invite") ? user : null;
}

/** Where a refused sign-in lands: AccessDenied is Auth.js's own (`false`); the rest name
 *  their case on /login, and a deleted account carries its date. */
export function signInRedirect(o: Extract<SignInOutcome, { kind: "refused" }>): string | false {
  if (o.code === "AccessDenied") return false;
  return `/login?error=${o.code}${o.deletedOn ? `&on=${o.deletedOn}` : ""}`;
}

/** What /login says for each (src/lib/login-error.ts takes these at Phase 2's turn). */
export function signInRefusalMessage(code: string, on?: string): string | null {
  if (code === "NoAccountId") return "Spotify didn't say which account this is, so Lazy Boy can't sign it in. Try again later.";
  if (code === "AccountDisabled") return "This account is paused. Ask Rem.";
  if (code === "AccountDeleted") {
    return `This account was deleted${on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? ` on ${on}` : ""}. Ask Rem for a new invite.`;
  }
  return null;
}
