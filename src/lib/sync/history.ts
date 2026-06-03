import "server-only";
import { spotifyClient } from "@/lib/spotify";
import {
  recordPlays,
  recordContexts,
  unresolvedContextUris,
  setLastSyncStats,
  type PlayRecord,
  type ContextRecord,
} from "@/lib/db";

type Spotify = ReturnType<typeof spotifyClient>;

// Core listen-history sync, shared by the manual "Sync recent plays" button
// (session-bound client) and the background scheduler (stored-token client).
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
  const added = recordPlays(rows);

  // Resolve names for any contexts we don't have yet (cap per sync to be gentle).
  const pending = unresolvedContextUris().slice(0, 20);
  const resolved: ContextRecord[] = [];
  for (const c of pending) {
    const r = await sp.contextName(c.uri);
    if (r) resolved.push({ uri: c.uri, name: r.name, type: r.type });
  }
  recordContexts(resolved);

  setLastSyncStats(added);
  return { added };
}
