"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Background refresh for a single playlist's cached tracks. The detail page renders the
// cached list instantly; this fires a re-fetch when that cache is empty or older than
// 30 min, then refreshes the view. Per-playlist cooldown (module scope) so bouncing
// between playlists doesn't spam Spotify.
const STALE_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const lastAttempt = new Map<string, number>();

export function PlaylistTracksSync({
  playlistId,
  syncedAt,
}: {
  playlistId: string;
  syncedAt: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    const stale = !syncedAt || Date.now() - new Date(syncedAt).getTime() > STALE_MS;
    if (!stale) return;
    if (Date.now() - (lastAttempt.get(playlistId) ?? 0) < COOLDOWN_MS) return;
    lastAttempt.set(playlistId, Date.now());
    let mounted = true;
    fetch(`/api/playlists/${playlistId}/tracks`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (mounted && d.ok) router.refresh();
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [playlistId, syncedAt, router]);
  return null;
}
