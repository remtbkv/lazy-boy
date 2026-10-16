import { cronAuthorized } from "@/lib/cron-auth";
import { benchStore } from "@/lib/db";

// Store round-trip timings from inside a production function (docs/STORE_MIGRATION.md §6.5,
// requirement R1): `?store=core` (default) or `?store=telemetry`. Reads only; the history
// payload probe records its modeled cost in the ledger like any other read. The response names
// the store's host, never a token.
let warm = false;

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const cold = !warm;
  warm = true;
  const store = new URL(req.url).searchParams.get("store") ?? "core";
  if (store !== "core" && store !== "telemetry") {
    return Response.json({ ok: false, error: "store must be core or telemetry" }, { status: 400 });
  }
  const result = await benchStore(store);
  return Response.json(
    { ok: true, region: process.env.VERCEL_REGION ?? null, cold, ...result },
    { headers: { "cache-control": "no-store" } },
  );
}
