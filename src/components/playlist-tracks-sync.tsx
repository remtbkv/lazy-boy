"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches a playlist's tracks into the cache, then refreshes the view. The detail
// page renders this ONLY when the playlist's Spotify snapshot_id differs from the cached
// one (or the cache is empty), so an unchanged playlist is never re-paginated. It just
// fires once on mount; the cooldown (keyed by playlist + snapshot) guards double-fires
// without blocking a genuinely new snapshot.
const COOLDOWN_MS = 60 * 1000;
const lastAttempt = new Map<string, number>();

export function PlaylistTracksSync({
  playlistId,
  snapshot,
}: {
  playlistId: string;
  snapshot?: string;
}) {
  const router = useRouter();
  useEffect(() => {
    const key = `${playlistId}:${snapshot ?? ""}`;
    if (Date.now() - (lastAttempt.get(key) ?? 0) < COOLDOWN_MS) return;
    lastAttempt.set(key, Date.now());
    let mounted = true;
    fetch(`/api/playlists/${playlistId}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot }),
    })
      .then((r) => r.json())
      .then((d) => {
        // Only refresh when the tracks actually changed — an unchanged snapshot returns
        // {ok:true, changed:false} and must not trigger a needless re-render.
        if (mounted && d.ok && d.changed) router.refresh();
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [playlistId, snapshot, router]);
  return null;
}
