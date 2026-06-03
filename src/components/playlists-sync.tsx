"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const STALE_MS = 15 * 60 * 1000; // re-sync the library at most every 15 min
const COOLDOWN_MS = 60 * 1000; // after any attempt, don't re-fire for a while

// App-wide guards (module scope) so navigating between pages — each of which
// mounts this — never spawns overlapping syncs or retries in a tight loop while
// rate-limited. That spiral is what made the page feel "stuck".
let inFlight = false;
let lastAttempt = 0;

// Fire-and-forget: if the stored library is empty or stale, kick a single
// background sync and refresh the server data when it lands — without ever
// blocking navigation or re-firing as you move around.
export function PlaylistsSync({ syncedAt }: { syncedAt: string | null }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let mounted = true;
    const stale = !syncedAt || Date.now() - new Date(syncedAt).getTime() > STALE_MS;
    if (!stale) return;
    // Something is already syncing, or we tried very recently — don't pile on.
    // (Whoever fired the in-flight sync owns the indicator + refresh.)
    if (inFlight) return;
    if (Date.now() - lastAttempt < COOLDOWN_MS) return;

    inFlight = true;
    lastAttempt = Date.now();
    // Reflect the background sync we're firing right here. The set-state-in-effect
    // rule can't tell this from a pointless cascade, but it's the legitimate
    // "show pending UI while an external op runs" case (one extra render on mount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSyncing(true);
    fetch("/api/playlists/sync", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        // Only refresh if still on this page — never yank a page you navigated to.
        if (mounted && d.ok) router.refresh();
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (mounted) setSyncing(false);
      });

    return () => {
      mounted = false;
    };
  }, [syncedAt, router]);

  if (!syncing) return null;
  return (
    <span className="text-xs text-muted-foreground/70" aria-live="polite">
      syncing…
    </span>
  );
}
