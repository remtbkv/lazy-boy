import { cronAuthorized } from "@/lib/cron-auth";
import { runUsageCheck } from "@/lib/usage-check";

// The Turso quota guard's HTTP face: 500 on a breach or a residual alarm, so an external
// caller with failure notifications turns it into an e-mail. The logic, and why it exists,
// is in src/lib/usage-check.ts; /api/cron/daily runs the same check every day and only records
// it. ?allowance= overrides the pace multiplier so the breach path is provable on demand.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 401 });
  }
  const allowance = Number(new URL(req.url).searchParams.get("allowance")) || undefined;
  const { status, body } = await runUsageCheck(allowance);
  return Response.json(body, { status });
}
