// The decisions auth.ts's callbacks and requireUser() make about identity, kept free of any
// next-auth runtime import so the simulated environment can test them (auth.ts pulls in
// next/server, which it cannot load). PLAN.md §5.1.
import type { Session } from "next-auth";
import { isUidShape, mintUid, type IdentityVerdict, type Uid } from "@/lib/identity";

export type SignInClaims = { uid: string; ep: number; auth_time: number };

/** What the jwt callback's sign-in branch puts on the cookie: taken from the user's row (in
 *  Phase 1, the owner constant), never from the incoming cookie or the profile, which is what
 *  keeps session fixation out. `auth_time` is written here and nowhere else. */
export function signInClaims(owner: string | null, now: number): SignInClaims | null {
  if (!isUidShape(owner)) return null;
  return { uid: owner, ep: 0, auth_time: Math.floor(now / 1000) };
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
): { uid?: string; admin?: boolean; idUnavailable?: true } {
  if (verdict.kind === "allowed") return { uid: verdict.uid, admin: verdict.admin };
  if (verdict.kind === "unavailable") return { idUnavailable: true };
  return {};
}

export type Gate = { uid: Uid; admin: boolean; canCallSpotify: boolean };
export type GateResult =
  | { kind: "allowed"; gate: Gate }
  | { kind: "refused" }
  | { kind: "unavailable" };

/** requireUser()'s rule over what auth() returned. A uid is minted here and only here on the
 *  request path. */
export function gateFromSession(session: Session | null): GateResult {
  if (!session) return { kind: "refused" };
  if (session.idUnavailable) return { kind: "unavailable" };
  if (!isUidShape(session.uid)) return { kind: "refused" };
  return {
    kind: "allowed",
    gate: { uid: mintUid(session.uid), admin: session.admin === true, canCallSpotify: !session.error },
  };
}
