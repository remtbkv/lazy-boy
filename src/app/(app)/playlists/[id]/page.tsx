import Link from "next/link";
import { notFound } from "next/navigation";
import { getSpotify } from "@/lib/session";
import { findDuplicates } from "@/lib/spotify/domain";
import { SpotifyError } from "@/lib/spotify";
import { CleanPanel } from "@/components/clean-panel";
import { PlaylistThumb } from "@/components/playlist-thumb";
import { TrackList } from "@/components/track-list";

export default async function PlaylistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sp = await getSpotify();

  let playlist;
  let tracks;
  try {
    [playlist, tracks] = await Promise.all([sp.playlist(id), sp.playlistTracks(id)]);
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 404) notFound();
    throw e;
  }

  const duplicateIds = findDuplicates(tracks).map((t) => t.id);

  return (
    <div className="space-y-8">
      <Link
        href="/playlists"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All playlists
      </Link>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="w-40 shrink-0">
          <PlaylistThumb src={playlist.image} name={playlist.name} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-3xl font-bold tracking-tight">
            {playlist.name}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {playlist.ownerName} · {playlist.trackCount} tracks
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="order-2 lg:order-1">
          <TrackList
            playlistId={id}
            tracks={tracks}
            duplicateIds={duplicateIds}
          />
        </div>
        <aside className="order-1 lg:order-2">
          <CleanPanel playlistId={id} />
        </aside>
      </div>
    </div>
  );
}
