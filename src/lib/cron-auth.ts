import "server-only";
import { timingSafeEqual } from "node:crypto";

/** The one CRON_SECRET check every /api/cron/* route uses: `Authorization: Bearer
 *  $CRON_SECRET`, compared in constant time so the secret can't be guessed from response
 *  timing. Fails closed: with CRON_SECRET unset, nobody is authorized (an unset secret in a
 *  deploy would otherwise leave the routes open). Every holder of the secret is listed in
 *  docs/SECURITY.md. */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(req.headers.get("authorization") ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
