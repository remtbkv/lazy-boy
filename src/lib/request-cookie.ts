// The signed request cookie (RULINGS Oct 15 12:46 PM; FASTPATH.md §5): development mode returns no
// e-mail from /v1/me, so nothing in a sign-in says which request it answers. The request form (or
// the join link Rem sends, for another browser) leaves this cookie, and the friend's sign-in
// claims the invite of the request it names (identity-read.ts resolveSignIn).
//
// `v1.<request id>.<expires, epoch s>.<mac>`, the mac an HMAC-SHA256 under a key derived from
// AUTH_SECRET for this purpose alone, so a cookie cannot be made, re-pointed at another request or
// extended without the deployment's secret. It is a bearer of one request for two days; the claim
// it enables is single-use (app-db.ts claimInvite's compare-and-set).
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const REQUEST_COOKIE = "lb-request";
export const REQUEST_COOKIE_TTL_S = 2 * 86_400;
const ID_RE = /^[a-z2-7]{12}$/;

function mac(secret: string, body: string): string {
  const key = Buffer.from(hkdfSync("sha256", secret, "", "lazyboy:request-cookie:v1", 32));
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function signRequestCookie(requestId: string, nowMs: number, secret = process.env.AUTH_SECRET): string {
  if (!secret) throw new Error("request cookie: AUTH_SECRET is unset");
  if (!ID_RE.test(requestId)) throw new Error("request cookie: not a request id");
  const body = `v1.${requestId}.${Math.floor(nowMs / 1000) + REQUEST_COOKIE_TTL_S}`;
  return `${body}.${mac(secret, body)}`;
}

/** The request id a cookie names, or null if it is unsigned, altered, expired or not ours. */
export function verifyRequestCookie(value: string | undefined | null, nowMs: number, secret = process.env.AUTH_SECRET): string | null {
  if (!secret || !value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !ID_RE.test(parts[1]) || !/^[0-9]{1,12}$/.test(parts[2])) return null;
  const body = parts.slice(0, 3).join(".");
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(parts[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(parts[2]) * 1000 < nowMs) return null;
  return parts[1];
}
