import "server-only";

// cron-job.org (the every-2-min pinger that keeps closed-app history sync alive) disables a
// job automatically after too many consecutive failed executions. The sync depends on that
// job staying enabled, so the daily Vercel cron doubles as a watchdog: if it finds the job
// disabled, it re-enables it — self-healing without a manual click. The disable email still
// fires, so a genuine failure is still surfaced; this just stops it from being permanent.
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
    if (!res.ok) return "error";
    const job = (await res.json())?.jobDetails;
    if (job?.enabled) return "already-on";
    const patch = await fetch(`${API}/jobs/${jobId}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ job: { enabled: true } }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    return patch.ok ? "enabled" : "error";
  } catch {
    return "error";
  }
}
