import { after } from "next/server";
import { recordClientMetrics, type ClientMetricInput } from "@/lib/db";
import { SERVER_ONLY_EVENTS } from "@/lib/isolation";
import { requireRouteUser } from "@/lib/require-user";

// Where the browser files what it measured (src/lib/metrics-client.ts sends it, db.ts's
// "Client performance metrics" stores it). Body: { session, events: [{page, event, value?,
// meta?}] }, delivered by navigator.sendBeacon — which carries the session cookie, so the
// gate works the same as on any other route here. The rows are filed under the session's uid,
// never one from the body, and an event name the server reserves for itself (`isolation`,
// which turns the health check red) is dropped: a client cannot raise, or fake, an alarm
// (multi-user PLAN §6.2 layer 7, T15).
//
// THIS ENDPOINT MUST NEVER BREAK THE APP IT MEASURES: everything past the auth check is
// wrapped, and a failed insert answers 204 like a successful one. The beacon has nowhere to
// report an error to anyway, and a dropped timing is a hole in a diagnostic — the same
// contract logSpotifyRequest and the read-cost ledger hold to. The insert itself runs in
// after(), once the 204 is sent: it goes to the telemetry store (the Zenbook, behind the
// Funnel), and the beacon must not wait on that host (docs/STORE_MIGRATION.md §6.4).
const MAX_EVENTS = 50;
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const user = await requireRouteUser();
  if (user instanceof Response) return user;

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
      if (SERVER_ONLY_EVENTS.has(event)) continue;
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
    if (rows.length > 0) {
      after(() =>
        recordClientMetrics(rows, user.uid).catch(() => {
          /* same contract as above: a lost timing never becomes an error */
        }),
      );
    }
  } catch {
    /* a metric that can't be stored is not worth an error in the client path */
  }
  return new Response(null, { status: 204 });
}
