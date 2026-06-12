import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getSpotify } from "@/lib/session";
import {
  getMeId,
  getPlaylistSnapshot,
  getPlaylistTracks,
  getStoredPlaylist,
  storePlaylistTracks,
} from "@/lib/db";
import { findDuplicates } from "@/lib/spotify/domain";
import { formatListenTime } from "@/lib/format";
import { SpotifyError, type Track, type Playlist } from "@/lib/spotify";
import { PlaylistThumb } from "@/components/playlist-thumb";
import { PlaylistTracksSync } from "@/components/playlist-tracks-sync";
import { TrackList } from "@/components/track-list";
import { Skeleton } from "@/components/ui/skeleton";

export default async function PlaylistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Render entirely from the local store — no Spotify call on the critical path. A live
  // call here (even the single "get header" one) blocks the whole page for the full
  // Retry-After window whenever Spotify is rate-limiting, which is what made detail pages
  // take 10+ seconds. Freshness is checked in the background instead (PlaylistTracksSync),
  // which only re-paginates when the snapshot_id actually changed.
  const [meId, cachedTracks, cachedSnapshot, stored] = await Promise.all([
    getMeId(),
    getPlaylistTracks(id),
    getPlaylistSnapshot(id),
    getStoredPlaylist(id),
  ]);
  let cached = stored;
  // If the cold path below fetches the live header, hand it to <Tracks> so it doesn't
  // re-fetch the same playlist a second time.
  let coldLive: Playlist | undefined;

  // Only when we have nothing cached at all (unknown id — e.g. a stale link to a deleted
  // playlist) do we have to ask Spotify, both for the header and to surface a real 404.
  if (!cached && cachedTracks.length === 0) {
    const sp = await getSpotify();
    try {
      const live = await sp.playlist(id);
      coldLive = live;
      cached = {
        id,
        name: live.name,
        ownerId: live.ownerId,
        image: live.image,
        trackCount: live.trackCount,
      };
    } catch (e) {
      if (e instanceof SpotifyError && e.status === 404) notFound();
      // Rate-limited or another transient blip and nothing cached to fall back on —
      // show a friendly note instead of a 500 error page.
      return (
        <div className="space-y-6">
          <Link
            href="/playlists"
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-white/25 hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            All playlists
          </Link>
          <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            Couldn&apos;t load this playlist right now — Spotify rate-limited the request.
            Refresh to try again.
          </div>
        </div>
      );
    }
  }

  const name = cached?.name ?? "Playlist";
  const image = cached?.image ?? null;
  const ownerId = cached?.ownerId ?? null;
  const trackCount = cached?.trackCount ?? cachedTracks.length;
  const isMine = !!meId && ownerId === meId;
  const totalMs = cachedTracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

  return (
    <div className="space-y-6">
      <Link
        href="/playlists"
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-white/25 hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All playlists
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="w-40 shrink-0">
          <PlaylistThumb src={image} name={name} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-bold tracking-tight select-text">{name}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isMine || !ownerId ? null : <>{ownerId} · </>}
            {trackCount} tracks
            {totalMs > 0 ? ` · ${formatListenTime(totalMs)}` : null}
          </p>
        </div>
      </div>

      {/* Serve the cached track list instantly (no Spotify pagination on render); a
          background check refreshes it only when the playlist's snapshot_id changed.
          First ever visit (cold cache) streams a live fetch that also fills the cache. */}
      {cachedTracks.length > 0 ? (
        <>
          <TrackList
            tracks={cachedTracks}
            duplicateIds={findDuplicates(cachedTracks).map((t) => t.id)}
            playlistId={id}
            canRemove={isMine}
          />
          <PlaylistTracksSync playlistId={id} snapshot={cachedSnapshot ?? undefined} />
        </>
      ) : (
        <Suspense fallback={<TracksSkeleton />}>
          <Tracks id={id} canRemove={isMine} live={coldLive} />
        </Suspense>
      )}
    </div>
  );
}

// Cold-cache path: fetch live from Spotify, fill the cache (with the real snapshot so
// future visits stay on the fast cache path), render.
async function Tracks({
  id,
  canRemove,
  live,
}: {
  id: string;
  canRemove: boolean;
  live?: Playlist;
}) {
  const sp = await getSpotify();
  let tracks: Track[] | null = null;
  let snapshot: string | undefined;
  let status = 0;
  try {
    // Reuse the header the cold path already fetched (if any) — only the track list is
    // still missing — instead of paying for a second sp.playlist(id) call.
    if (live) {
      snapshot = live.snapshot;
      tracks = await sp.playlistTracks(id);
    } else {
      const [pl, tr] = await Promise.all([sp.playlist(id), sp.playlistTracks(id)]);
      snapshot = pl.snapshot;
      tracks = tr;
    }
  } catch (e) {
    status = e instanceof SpotifyError ? e.status : 0;
    tracks = null;
  }

  if (!tracks) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {status === 403
          ? "This playlist belongs to another account, so Spotify won't let this app read its tracks. Sorry, the API update is bad."
          : "Couldn't load this playlist's tracks — Spotify rate-limited the request. Refresh to try again."}
      </div>
    );
  }

  await storePlaylistTracks(id, tracks, snapshot);
  const duplicateIds = findDuplicates(tracks).map((t) => t.id);
  return (
    <TrackList
      tracks={tracks}
      duplicateIds={duplicateIds}
      playlistId={id}
      canRemove={canRemove}
    />
  );
}

function TracksSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-24" />
      <div className="space-y-2 rounded-lg border border-border p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
