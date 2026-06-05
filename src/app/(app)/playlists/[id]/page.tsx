import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getSpotify } from "@/lib/session";
import {
  getMeId,
  getPlaylistSnapshot,
  getPlaylistTracks,
  getStoredPlaylists,
  storePlaylistTracks,
} from "@/lib/db";
import { findDuplicates } from "@/lib/spotify/domain";
import { SpotifyError, type Playlist, type Track } from "@/lib/spotify";
import { CleanMenu } from "@/components/clean-menu";
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
  const sp = await getSpotify();

  // Header (one fast call). A 404 means it's gone. Any other failure (a global cooldown
  // after a 429, a dev-mode 403, a transient blip) must NOT take down the whole page —
  // the cached track list below still works — so fall back to the cached library row for
  // the header and let the page render degraded instead of hitting the error boundary.
  let playlist: Playlist;
  try {
    playlist = await sp.playlist(id);
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 404) notFound();
    const cached = (await getStoredPlaylists()).find((p) => p.id === id);
    if (!cached) throw e; // nothing cached either → let the boundary handle it
    playlist = {
      id,
      name: cached.name,
      description: "",
      ownerId: cached.ownerId ?? "",
      ownerName: cached.ownerId ?? "",
      trackCount: cached.trackCount,
      image: cached.image,
      public: false,
      collaborative: false,
    };
  }

  // Hide the owner line when it's the user's own playlist — they know.
  const [meId, cachedTracks, cachedSnapshot] = await Promise.all([
    getMeId(),
    getPlaylistTracks(id),
    getPlaylistSnapshot(id),
  ]);
  const isMine = !!meId && playlist.ownerId === meId;
  // Only the playlist's snapshot_id changing means its tracks changed — so we refresh
  // the cache exactly when (and only when) that differs, never on a blind timer.
  const tracksStale = cachedTracks.length > 0 && cachedSnapshot !== (playlist.snapshot ?? null);

  return (
    <div className="space-y-8">
      <Link
        href="/playlists"
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-white/25 hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All playlists
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="w-40 shrink-0">
          <PlaylistThumb src={playlist.image} name={playlist.name} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-bold tracking-tight select-text">
            {playlist.name}
          </h1>
          {playlist.description ? (
            <p className="mt-1.5 line-clamp-2 text-sm text-foreground/80 select-text">
              {playlist.description}
            </p>
          ) : null}
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isMine ? null : <>{playlist.ownerName} · </>}
            {playlist.trackCount} tracks
          </p>
        </div>
        {/* Clean lives here as a header action (popover) rather than a side column,
            so the track list gets the full width. */}
        <CleanMenu playlistId={id} />
      </div>

      {/* Serve the cached track list instantly (no Spotify pagination on render);
          a background refresh updates it when it's empty or >30 min stale. First
          ever visit (cold cache) streams a live fetch that also fills the cache. */}
      {cachedTracks.length > 0 ? (
        <>
          <TrackList
            tracks={cachedTracks}
            duplicateIds={findDuplicates(cachedTracks).map((t) => t.id)}
            playlistId={id}
            canRemove={isMine}
          />
          {tracksStale ? (
            <PlaylistTracksSync playlistId={id} snapshot={playlist.snapshot} />
          ) : null}
        </>
      ) : (
        <Suspense fallback={<TracksSkeleton />}>
          <Tracks id={id} canRemove={isMine} snapshot={playlist.snapshot} />
        </Suspense>
      )}
    </div>
  );
}

// Cold-cache path: fetch live from Spotify, fill the cache for next time, render.
async function Tracks({
  id,
  canRemove,
  snapshot,
}: {
  id: string;
  canRemove: boolean;
  snapshot?: string;
}) {
  const sp = await getSpotify();
  let tracks: Track[] | null = null;
  let status = 0;
  try {
    tracks = await sp.playlistTracks(id);
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
