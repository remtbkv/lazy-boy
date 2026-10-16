import "server-only";
import { timingSafeEqual } from "node:crypto";
import { meterRequest, meterStart } from "@/lib/budget/request-meter";

/** The CRON_SECRET check every /api/cron/* route but sync uses: `Authorization: Bearer
 *  $CRON_SECRET`, compared in constant time so the secret can't be guessed from response
 *  timing. Fails closed: with CRON_SECRET unset, nobody is authorized (an unset secret in a
 *  deploy would otherwise leave the routes open). CRON_SECRET_EXT opens none of these routes
 *  (docs/multi-user/PLAN.md §5.5). Every holder of either secret is listed in docs/SECURITY.md. */
export function cronAuthorized(req: Request): boolean {
  return cronCaller(req.headers.get("authorization")) === "zenbook";
}

// Which pinger is calling (docs/multi-user/PLAN.md §5.5, §7.2): the Zenbook's timer holds
// CRON_SECRET, cron-job.org holds CRON_SECRET_EXT, which opens only /api/cron/sync and
// /api/cron/health. Constant-time compares; an unset secret matches nobody (fail closed).
export type CronCaller = "zenbook" | "ext";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function cronCaller(authorization: string | null): CronCaller | null {
  // The CPU meter's choke point for the cron routes (lib/budget/request-meter.ts);
  // cronAuthorized comes through here too.
  meterRequest(meterStart(), null);
  const got = authorization ?? "";
  const zen = process.env.CRON_SECRET;
  const ext = process.env.CRON_SECRET_EXT;
  if (zen && safeEqual(got, `Bearer ${zen}`)) return "zenbook";
  if (ext && safeEqual(got, `Bearer ${ext}`)) return "ext";
  return null;
}
