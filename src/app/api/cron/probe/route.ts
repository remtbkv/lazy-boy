// The planted probe (docs/multi-user/PLAN.md §13.1, Phase 4a's row; RULINGS Oct 15 9:27 PM: no
// canary account, so lane 28 runs it in the two-user rehearsal and lane 29 in production before
// friends can request access). Two calls, a few seconds apart (Next stores a forged entry only
// when the request that made it ends):
//   POST {"uid": <the key's owner>, "stamp": <another uid>}  -> 202 {"ok":true,"nonce":"…"}
//     forges one cache entry under uid's key stamped with `stamp`; `stamp` need not belong to any
//     users row (lane 29 stamps Rem's key with one no row holds);
//   POST {"uid": <the same>, "nonce": <the nonce>}           -> 200 {"ok":true,"events":1}
//     reads it back through userCache, whose owner check records exactly one `cache-stamp` event,
//     so the next health check is red and e-mails Rem.
//
// Opened by the Zenbook's CRON_SECRET only, never CRON_SECRET_EXT: cron-job.org's secret can tick
// and ask for health, and must not be able to raise an alarm. It reads no user data and writes
// nothing but the forged entry, under the probe's own wrapper, and the event.
import { randomUUID } from "node:crypto";
import { countEvents } from "@/lib/app-db";
import { cronCaller } from "@/lib/cron-auth";
import { isUidShape } from "@/lib/identity";
import { forgeProbeEntry, readProbeEntry } from "@/lib/user-cache";

export const dynamic = "force-dynamic";

const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = () => Response.json({ ok: false, error: "uid with a different stamp, or uid with its nonce" }, { status: 400 });

export async function POST(req: Request) {
  if (cronCaller(req.headers.get("authorization")) !== "zenbook") {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { uid?: unknown; stamp?: unknown; nonce?: unknown } | null;
  const uid = body?.uid;
  if (!isUidShape(uid)) return bad();
  if (body?.stamp !== undefined) {
    if (!isUidShape(body.stamp) || body.stamp === uid || body.nonce !== undefined) return bad();
    const nonce = randomUUID();
    await forgeProbeEntry(uid, body.stamp, nonce);
    return Response.json({ ok: true, nonce }, { status: 202 });
  }
  if (typeof body?.nonce !== "string" || !NONCE_RE.test(body.nonce)) return bad();
  const before = await countEvents(uid, "cache-stamp");
  await readProbeEntry(uid, body.nonce);
  const events = (await countEvents(uid, "cache-stamp")) - before;
  return Response.json({ ok: events === 1, events }, { status: events === 1 ? 200 : 500 });
}
