import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getSpotify } from "@/lib/session";
import { getMeId } from "@/lib/db";
import { findDuplicates } from "@/lib/spotify/domain";
import { SpotifyError, type Track } from "@/lib/spotify";
import { CleanMenu } from "@/components/clean-menu";
import { PlaylistThumb } from "@/components/playlist-thumb";
import { TrackList } from "@/components/track-list";
import { Skeleton } from "@/components/ui/skeleton";

export default async function PlaylistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sp = await getSpotify();

  // Only the playlist header is awaited (one fast call). A 404 means it's gone;
  // any other failure bubbles to the error boundary.
  let playlist;
  try {
    playlist = await sp.playlist(id);
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 404) notFound();
    throw e;
  }

  // Hide the owner line when it's the user's own playlist — they know.
  const meId = await getMeId();
  const isMine = !!meId && playlist.ownerId === meId;

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

      {/* The track list paginates and can be slow / rate-limited, so it streams
          in behind the header instead of blocking the whole page. */}
      <Suspense fallback={<TracksSkeleton />}>
        <Tracks id={id} canRemove={isMine} />
      </Suspense>
    </div>
  );
}

async function Tracks({ id, canRemove }: { id: string; canRemove: boolean }) {
  const sp = await getSpotify();
  // Fetch in the try; build the JSX outside it (a render-time throw wouldn't be
  // caught here anyway — that's what the route's error boundary is for).
  let tracks: Track[] | null = null;
  try {
    tracks = await sp.playlistTracks(id);
  } catch {
    tracks = null;
  }

  if (!tracks) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        Couldn&apos;t load this playlist&apos;s tracks — Spotify rate-limited the
        request. Refresh to try again.
      </div>
    );
  }

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
