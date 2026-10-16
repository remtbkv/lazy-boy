// Re-enabling the two cron-job.org jobs (PLAN.md §7.10-7.11): the every-2-minute pinger and the
// hourly health check. cron-job.org disables a job after a run of failed executions, and its
// failure e-mail is the alarm, so a disabled health job would silence every alarm after the first.
// The daily chores look at each job and enable it if cron-job.org turned it off; the e-mail that
// came with the disable has already gone out. CRONJOB_API_KEY and CRONJOB_JOB_IDS (comma-separated
// job ids) in Production; either unset, it does nothing. It never throws.
import "server-only";

const API = "https://api.cron-job.org";

export type JobOutcome = "enabled" | "already-on" | "error";

export async function ensureCronJobsEnabled(env: Record<string, string | undefined> = process.env): Promise<Record<string, JobOutcome> | "skipped"> {
  const key = env.CRONJOB_API_KEY;
  const ids = (env.CRONJOB_JOB_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9]+$/.test(s));
  if (!key || ids.length === 0) return "skipped";
  const auth = { Authorization: `Bearer ${key}` };
  const out: Record<string, JobOutcome> = {};
  for (const id of ids) {
    try {
      const res = await fetch(`${API}/jobs/${id}`, { headers: auth, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        console.error(`[cronjob] job ${id}: check failed ${res.status}`);
        out[id] = "error";
        continue;
      }
      if ((await res.json())?.jobDetails?.enabled) {
        out[id] = "already-on";
        continue;
      }
      const patch = await fetch(`${API}/jobs/${id}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ job: { enabled: true } }),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!patch.ok) console.error(`[cronjob] job ${id}: enable failed ${patch.status}`);
      out[id] = patch.ok ? "enabled" : "error";
    } catch {
      out[id] = "error";
    }
  }
  return out;
}
