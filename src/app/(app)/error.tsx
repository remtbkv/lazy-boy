"use client";

import { useEffect } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function AppError({ error }: { error: Error & { digest?: string } }) {
  const isAuthError = /not authenticated/i.test(error.message);
  // A deploy gives server actions fresh ids, so a tab left open across a deploy posts an id
  // the new build doesn't have ("Failed to find Server Action …"). That's purely a stale-build
  // mismatch, not a real failure — reload once to pull the current build and land back where
  // you were. Guarded by a timestamp so a genuinely persistent error can't loop (won't retry
  // within 10s), while a later deploy still recovers.
  const isStaleAction = /server action|failed to find/i.test(error.message);
  useEffect(() => {
    if (!isStaleAction) return;
    const KEY = "stale-action-reload-at";
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
  }, [isStaleAction]);

  if (isStaleAction) {
    return (
      <div className="mx-auto max-w-md space-y-2 py-16 text-center">
        <h2 className="text-xl font-semibold">Updating…</h2>
        <p className="text-sm text-muted-foreground">Loading the latest version.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">
        {isAuthError
          ? "Your Spotify session expired. Please sign in again."
          : error.message}
      </p>
      {/* Neutral outline, matching the in-app buttons (quick-action pills) — not the green
          primary, which we reserve for the Spotify-brand login CTA. */}
      <Link href="/login" className={buttonVariants({ variant: "outline" })}>
        Back to sign in
      </Link>
    </div>
  );
}
