// The decisions auth.ts's callbacks and requireUser() make about identity, kept free of any
// next-auth runtime import so the simulated environment can test them (auth.ts pulls in
// next/server, which it cannot load). PLAN.md §5.1.
import type { Session } from "next-auth";
import { isUidShape, mintUid, type IdentityVerdict, type Uid } from "@/lib/identity";

export type SignInClaims = { uid: string; ep: number; auth_time: number };

/** What the jwt callback's sign-in branch puts on the cookie: taken from the user's `users`
 *  row (its uid and session epoch), never from the incoming cookie or the profile, which is
 *  what keeps session fixation out. `auth_time` is written here and nowhere else. */
export function signInClaims(user: { uid: string; sessionEpoch: number } | null, now: number): SignInClaims | null {
  if (!user || !isUidShape(user.uid)) return null;
  return { uid: user.uid, ep: user.sessionEpoch, auth_time: Math.floor(now / 1000) };
}

/** The jwt callback's answer for a later request: null signs the request out (Auth.js clears
 *  the cookie); allowed and unavailable keep the cookie exactly as it is. */
export function gateJwt<T>(token: T, verdict: IdentityVerdict): T | null {
  return verdict.kind === "refused" ? null : token;
}

/** What the session callback adds. The uid is not a credential, and GET /api/auth/session
 *  serves it only to its own holder (§5.1, security R15); tokens stay off the session. */
export function sessionFields(
  verdict: IdentityVerdict,
  authTime?: unknown,
): { uid?: string; admin?: boolean; authTime?: number; idUnavailable?: true } {
  // `authTime` (the cookie's sign-in time, epoch s) is what Disconnect's ten-minute rule reads
  // (PLAN.md §5.4); like the uid it is no credential.
  if (verdict.kind === "allowed") {
    return { uid: verdict.uid, admin: verdict.admin, ...(typeof authTime === "number" ? { authTime } : {}) };
  }
  if (verdict.kind === "unavailable") return { idUnavailable: true };
  return {};
}

export type Gate = { uid: Uid; admin: boolean };
export type GateResult =
  | { kind: "allowed"; gate: Gate }
  | { kind: "refused" }
  | { kind: "unavailable" };

/** requireUser()'s rule over what auth() returned. A uid is minted here and only here on the
 *  request path. A session whose Spotify grant is gone (`error`: no token row, or a dead
 *  refresh) is refused everywhere, the rule the pages always applied (PLAN.md §5.4): one
 *  sign-in restores both reading and capture. */
export function gateFromSession(session: Session | null): GateResult {
  if (!session) return { kind: "refused" };
  if (session.idUnavailable) return { kind: "unavailable" };
  if (!isUidShape(session.uid) || session.error) return { kind: "refused" };
  return { kind: "allowed", gate: { uid: mintUid(session.uid), admin: session.admin === true } };
}
