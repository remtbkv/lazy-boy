import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import Link from "next/link";
import { Clock3, GitCompare, ListMusic, Users } from "lucide-react";
import { auth } from "@/lib/auth";
import { getStoredPlaylists, getMeId, getPlaylistsSyncedAt } from "@/lib/db";
import { PlaylistsSync } from "@/components/playlists-sync";
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

export default async function MePage() {
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

  // Read the library from the local store — instant, no Spotify call on render.
  // PlaylistsSync refreshes it in the background when it's empty or stale.
  const playlists = getStoredPlaylists();
  const meId = getMeId();
  const syncedAt = getPlaylistsSyncedAt();
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

      <section className="grid gap-4 sm:grid-cols-2">
        <ToolCard
          href="/playlists"
          icon={<ListMusic />}
          title="Playlists"
          desc={"Merge, remove songs saved elsewhere, save your precious queue.\nSome random stuff as well."}
        />
        <ToolCard
          href="/history"
          icon={<Clock3 />}
          title="Listening history"
          desc="Every song you've played. When, how often, and where from."
        />
        <ToolCard
          href="/compare"
          icon={<GitCompare />}
          title="Compare a friend"
          desc="Via songs saved and listened to."
        />
        <ToolCard
          href="/friends"
          icon={<Users />}
          title="Friends"
          desc="Have some fun together."
        />
      </section>

      <p className="border-t border-border/60 pt-6 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Lazy Boy</span> does Spotify stuff for you{" "}
        <span className="italic text-muted-foreground/50">(but he&apos;s not the lazy one, it seems)</span>
      </p>
    </div>
  );
}

function ToolCard({
  href,
  icon,
  title,
  desc,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-white/25 hover:bg-accent/30"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-white/5 text-foreground transition-colors group-hover:bg-white/10 [&_svg]:size-[18px]">
          {icon}
        </span>
        <h2 className="font-semibold">{title}</h2>
      </div>
      <p className="mt-2.5 text-sm text-muted-foreground whitespace-pre-line">{desc}</p>
    </Link>
  );
}
