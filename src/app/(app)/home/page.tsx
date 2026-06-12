import { readFileSync } from "node:fs";
import path from "node:path";
import { auth } from "@/lib/auth";
import { getStoredPlaylists, getMeId, getPlaylistsSyncedAt, getCleanBackupPref } from "@/lib/db";
import { PlaylistsSync } from "@/components/playlists-sync";
import { QuickActions } from "@/components/quick-actions";
import { GreetingHeading } from "@/components/greeting-heading";

// Playful greetings live in src/content/greetings.md (one is picked at random per
// load). Only "- " list lines count; "{name}" is swapped for the first name. Read
// fresh each request so edits to the file show up without a restart.
function loadGreetings(): string[] {
  try {
    const raw = readFileSync(path.join(process.cwd(), "src/content/greetings.md"), "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[-*]\s+/.test(l))
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
    return lines.length ? lines : ["Back for more?"];
  } catch {
    return ["Back for more?"];
  }
}

export default async function HomePage() {
  const session = await auth();
  const name = session?.user?.name ?? "You";
  const first = name.split(" ")[0] || name;
  const greetings = loadGreetings();
  // Server Component: a per-request random greeting is intentional. It's picked
  // here (not client-side) so it's deterministic for hydration, then frozen in
  // GreetingHeading's state. The purity rule targets client render; it doesn't
  // apply to a Server Component that renders fresh per request.
  // eslint-disable-next-line react-hooks/purity
  const greeting = greetings[Math.floor(Math.random() * greetings.length)].replace(
    "{name}",
    first,
  );

  // Read the library from the store — no Spotify call on render.
  // PlaylistsSync refreshes it in the background when it's empty or stale.
  const [playlists, meId, syncedAt, backupPref] = await Promise.all([
    getStoredPlaylists(),
    getMeId(),
    getPlaylistsSyncedAt(),
    getCleanBackupPref(),
  ]);
  const owned = meId ? playlists.filter((p) => p.ownerId === meId).length : 0;
  const totalSongs = playlists.reduce((n, p) => n + p.trackCount, 0);

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <GreetingHeading initial={greeting} />
        <p className="text-muted-foreground">
          {playlists.length > 0 ? (
            <>
              {playlists.length} playlists · {owned} created by you ·{" "}
              {totalSongs.toLocaleString()} total songs
            </>
          ) : (
            <span className="text-muted-foreground/70">Loading your library…</span>
          )}
        </p>
        <PlaylistsSync syncedAt={syncedAt} />
      </header>

      <QuickActions
        playlists={playlists.map((p) => ({
          id: p.id,
          name: p.name,
          trackCount: p.trackCount,
          image: p.image,
          // Lets the Subtract panel offer in-place removal only on playlists you own.
          mine: !!meId && p.ownerId === meId,
        }))}
        backupPref={backupPref}
      />

      <p className="border-t border-border/60 pt-6 text-sm text-muted-foreground">
        Just do this yourself, man.
      </p>
    </div>
  );
}
