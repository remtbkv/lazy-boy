"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

// The (app) error boundary. Three jobs beyond showing the message:
//   • REPORT: production RSC errors reach the browser as a generic line plus a digest —
//     the digest is the only thread back to the server logs, and Vercel's runtime logs
//     age out within the hour. So every landing here beacons page + digest + message into
//     client_metrics (the same js-error channel /usage prints verbatim), which is how a
//     "something went wrong at 9am" stays diagnosable at 9pm.
//   • SELF-HEAL: one guarded reload. The known transient classes both recover on retry —
//     a stale-build server-action id after a deploy, and a first-query-of-the-morning
//     timeout against the store over the funnel (Rem's stale-tab refresh, 2026-08-15).
//     The 10s timestamp guard means a genuinely persistent failure reloads once, comes
//     back here, and shows the real error page instead of looping.
//   • The sign-in link, for the auth case where a reload can't help.
export default function AppError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const isAuthError = /not authenticated/i.test(error.message);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    try {
      const meta = `rsc-error ${error.digest ?? "no-digest"} ${error.message}`.slice(0, 200);
      const body = JSON.stringify({
        session: "",
        events: [{ page: location.pathname, event: "js-error", value: 1, meta }],
      });
      navigator.sendBeacon?.("/api/metrics", new Blob([body], { type: "application/json" }));
    } catch {
      /* reporting must never add its own error */
    }
  }, [error]);

  useEffect(() => {
    if (isAuthError) return;
    const KEY = "app-error-reload-at";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    // One auto-reload per 10 MINUTES per tab. The old 10-second window measured
    // reload-initiation → next-failure-arrival, so any failure that took longer than 10s
    // to fail (a store/funnel timeout — the motivating case) reloaded forever at roughly
    // the timeout period (audit 2026-08-19, T2.8). A failure that recurs within the window
    // shows this page; a genuinely transient one is healed by the single reload.
    if (Date.now() - last < 10 * 60 * 1000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one flip, then a reload
    setRetrying(true);
    window.location.reload();
  }, [isAuthError]);

  if (retrying) {
    return (
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
        <div className="mx-auto max-w-md space-y-2 py-16 text-center">
          <h2 className="text-xl font-semibold">Reloading…</h2>
          <p className="text-sm text-muted-foreground">One moment.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-7 sm:px-6 sm:pb-20 sm:pt-6">
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <h2 className="text-xl font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">
          {isAuthError
            ? "Your Spotify session expired. Please sign in again."
            : error.message}
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-muted-foreground/60">{error.digest}</p>
        ) : null}
        {/* Neutral outline, matching the in-app buttons (quick-action pills) — not the green
          primary, which we reserve for the Spotify-brand login CTA. */}
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={buttonVariants({ variant: "outline" })}
          >
            Try again
          </button>
          <Link href="/login" className={buttonVariants({ variant: "outline" })}>
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
