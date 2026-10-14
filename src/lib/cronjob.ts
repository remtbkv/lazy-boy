import "server-only";

// cron-job.org was the every-2-min closed-app pinger until its bearer went stale at the
// 2026-08-10 CRON_SECRET rotation; the Zenbook's `lazyboy-cron-sync.timer` has carried that
// job since (whether to delete the cron-job.org job or refresh its secret is Rem's call,
// burn lazyboy-review Z2). cron-job.org disables a job automatically after too many
// consecutive failed executions, so the daily Vercel cron doubles as a watchdog: if it finds
// the job disabled, it re-enables it. The disable email still fires, so a genuine failure is
// still surfaced; this just stops it from being permanent.
// Needs CRONJOB_API_KEY (a cron-job.org API key) + CRONJOB_JOB_ID in the environment; a
// no-op if either is unset. Never throws — a watchdog must not break the request it rides on.
const API = "https://api.cron-job.org";

export async function ensureCronJobEnabled(): Promise<
  "enabled" | "already-on" | "skipped" | "error"
> {
  const key = process.env.CRONJOB_API_KEY;
  const jobId = process.env.CRONJOB_JOB_ID;
  if (!key || !jobId) return "skipped";
  const auth = { Authorization: `Bearer ${key}` };
  try {
    const res = await fetch(`${API}/jobs/${jobId}`, {
      headers: auth,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Logged, because the caller cannot see it: this function never throws, so a
      // watchdog that has been failing for weeks (expired API key, 429) was otherwise
      // indistinguishable from one that healed (wave-2 audit, G2).
      console.error(`[cronjob] enable check failed: ${res.status}`);
      return "error";
    }
    const job = (await res.json())?.jobDetails;
    if (job?.enabled) return "already-on";
    const patch = await fetch(`${API}/jobs/${jobId}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ job: { enabled: true } }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!patch.ok) console.error(`[cronjob] enable PATCH failed: ${patch.status}`);
    return patch.ok ? "enabled" : "error";
  } catch {
    return "error";
  }
}
