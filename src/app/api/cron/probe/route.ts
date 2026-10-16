// The planted probe (docs/multi-user/PLAN.md §13.1, Phase 4a's row; RULINGS Oct 15 9:27 PM: no
// canary account, so lane 28 runs it in the two-user rehearsal and lane 29 in production before
// friends can request access). POST {"uid": <the key's owner>, "stamp": <another uid>}: it forges
// one cache entry under `uid`'s key stamped with `stamp` and reads it back through userCache, so
// exactly one `cache-stamp` isolation event results, and the next health check is red and e-mails
// Rem. `stamp` need not belong to any users row (lane 29 stamps Rem's key with one no row holds).
//
// Opened by the Zenbook's CRON_SECRET only, never CRON_SECRET_EXT: cron-job.org's secret can tick
// and ask for health, and must not be able to raise an alarm. It reads no user data and writes
// nothing but the forged entry, under the probe's own wrapper, and the event.
import { randomUUID } from "node:crypto";
import { countEvents } from "@/lib/app-db";
import { cronCaller } from "@/lib/cron-auth";
import { isUidShape } from "@/lib/identity";
import { plantedProbe } from "@/lib/user-cache";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (cronCaller(req.headers.get("authorization")) !== "zenbook") {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { uid?: unknown; stamp?: unknown } | null;
  const uid = body?.uid;
  const stamp = body?.stamp;
  if (!isUidShape(uid) || !isUidShape(stamp) || uid === stamp) {
    return Response.json({ ok: false, error: "uid and stamp: two different uids" }, { status: 400 });
  }
  const before = await countEvents(uid, "cache-stamp");
  await plantedProbe(uid, stamp, randomUUID());
  const events = (await countEvents(uid, "cache-stamp")) - before;
  return Response.json({ ok: events === 1, events }, { status: events === 1 ? 200 : 500 });
}
