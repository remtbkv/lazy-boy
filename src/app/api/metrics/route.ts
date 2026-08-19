import { auth } from "@/lib/auth";
import { recordClientMetrics, type ClientMetricInput } from "@/lib/db";

// Where the browser files what it measured (src/lib/metrics-client.ts sends it, db.ts's
// "Client performance metrics" stores it). Body: { session, events: [{page, event, value?,
// meta?}] }, delivered by navigator.sendBeacon — which carries the session cookie, so auth()
// works the same as on any other route here.
//
// THIS ENDPOINT MUST NEVER BREAK THE APP IT MEASURES: everything past the auth check is
// wrapped, and a failed insert answers 204 like a successful one. The beacon has nowhere to
// report an error to anyway, and a dropped timing is a hole in a diagnostic — the same
// contract logSpotifyRequest and the read-cost ledger hold to.
const MAX_EVENTS = 50;
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request) {
  if (!(await auth())) return new Response("Unauthorized", { status: 401 });

  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

    const body = JSON.parse(raw) as {
      session?: unknown;
      events?: unknown;
    };
    const session = typeof body.session === "string" ? body.session.slice(0, 64) : "";
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > MAX_EVENTS) return new Response(null, { status: 413 });

    const rows: ClientMetricInput[] = [];
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const { page, event, value, meta, at } = e as Record<string, unknown>;
      if (typeof page !== "string" || typeof event !== "string") continue;
      rows.push({
        session,
        page: page.slice(0, 200),
        event: event.slice(0, 64),
        value: typeof value === "number" && Number.isFinite(value) ? value : null,
        meta: typeof meta === "string" ? meta.slice(0, 200) : null,
        // Observation time; the store clamps it (recordClientMetrics), so pass-through is safe.
        at: typeof at === "number" && Number.isFinite(at) ? at : null,
      });
    }
    await recordClientMetrics(rows);
  } catch {
    /* a metric that can't be stored is not worth an error in the client path */
  }
  return new Response(null, { status: 204 });
}
