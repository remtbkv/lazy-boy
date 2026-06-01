import Link from "next/link";
import { getSpotify } from "@/lib/session";
import { MergePanel } from "@/components/merge-panel";
import { QuickActions } from "@/components/quick-actions";
import { PlaylistThumb } from "@/components/playlist-thumb";

export default async function PlaylistsPage() {
  const sp = await getSpotify();
  const playlists = await sp.myPlaylists();

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Playlists</h1>
        <p className="mt-1 text-muted-foreground">
          {playlists.length} playlists. Open one to clean it or remove songs.
        </p>
      </div>

      <section className="space-y-4">
        <QuickActions />
        <MergePanel
          playlists={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            trackCount: p.trackCount,
          }))}
        />
      </section>

      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your playlists
        </h2>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {playlists.map((p) => (
            <li key={p.id}>
              <Link
                href={`/playlists/${p.id}`}
                className="group block rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40"
              >
                <PlaylistThumb src={p.image} name={p.name} />
                <p className="mt-3 truncate text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {p.trackCount} tracks
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
