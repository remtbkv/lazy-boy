import "server-only";
import { spotifyClient } from "@/lib/spotify";
import {
  recordPlays,
  recordContexts,
  unresolvedContextUris,
  type PlayRecord,
  type ContextRecord,
} from "@/lib/db";

type Spotify = ReturnType<typeof spotifyClient>;

// Core listen-history sync, shared by the on-load /api/sync (session-bound client)
// and the /api/cron/sync backstop (stored-token client).
// Pulls the last ~50 plays into the local store and resolves any new playback
// contexts (playlist/album names). recordPlays() stamps `last_sync`.
export async function syncRecentPlays(sp: Spotify): Promise<{ added: number }> {
  const recent = await sp.recentlyPlayed(50);
  const rows: PlayRecord[] = recent.map((r) => ({
    trackId: r.track.id,
    name: r.track.title,
    artist: r.track.artist,
    uri: r.track.uri,
    album: r.track.album ?? null,
    albumImage: r.track.albumImage ?? null,
    durationMs: r.track.durationMs ?? null,
    playedAt: r.playedAt,
    contextType: r.contextType,
    contextUri: r.contextUri,
  }));
  const added = await recordPlays(rows);

  // Resolve names for any contexts we don't have yet (cap per sync to be gentle).
  const pending = (await unresolvedContextUris()).slice(0, 20);
  const resolved: ContextRecord[] = [];
  // Resolve in small concurrent batches: faster than one-at-a-time, but still gentle on
  // Spotify's rate limit (the client's shared cooldown backs the whole batch off on a 429).
  // contextName returns null only for permanent failures (403/404) — record those with a
  // null name as a negative cache, so dead contexts stop being re-fetched on every sync.
  // Transient failures throw; those stay unresolved and retry next sync.
  for (let i = 0; i < pending.length; i += 4) {
    const batch = await Promise.all(
      pending.slice(i, i + 4).map(async (c) => {
        try {
          const r = await sp.contextName(c.uri);
          return r
            ? { uri: c.uri, name: r.name, type: r.type }
            : { uri: c.uri, name: null, type: c.type };
        } catch {
          return null; // transient — leave unresolved for the next sync
        }
      }),
    );
    for (const r of batch) if (r) resolved.push(r);
  }
  await recordContexts(resolved);

  return { added };
}
