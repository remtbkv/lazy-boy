// The hourly health check (docs/multi-user/PLAN.md §7.10): a cron-job.org job with failure
// e-mail calls this; a 500 is the e-mail. The reply carries reasons and the names of checks
// not yet measurable, never anything about anyone's listening (cron-job.org keeps bodies).
import { getCaptureHealth } from "@/lib/db";
import { cronCaller } from "@/lib/cron-auth";
import { healthVerdict } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cronCaller(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  let ownerCapture = null;
  try {
    ownerCapture = await getCaptureHealth();
  } catch {
    // The store did not answer: that is itself a reason to wake Rem.
    return Response.json({ ok: false, reasons: ["store"] }, { status: 500 });
  }
  const v = healthVerdict({ isolationEvents: null, ownerCapture, dailyAgeMs: null, quotaAhead: null });
  return Response.json(v, { status: v.ok ? 200 : 500 });
}
