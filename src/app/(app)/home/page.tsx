import { readFileSync } from "node:fs";
import path from "node:path";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import {
  getStoredPlaylists,
  getMeId,
  getPlaylistsSyncedAt,
  getCleanBackupPref,
  getDailyStats,
  getAllTimeStats,
  getPlaysByDay,
  hasPlaysBeforeDay,
  searchHistory,
} from "@/lib/db";
import { tzOffsetMinutes } from "@/lib/tz";
import { QuickActions } from "@/components/quick-actions";
import { GreetingHeading } from "@/components/greeting-heading";
import { HistoryClient } from "@/components/history-client";
import { Skeleton } from "@/components/ui/skeleton";

// Reads the DB fresh per request (also so the tz cookie is honoured for the history view).
export const dynamic = "force-dynamic";

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

  // Only the light queries the top panel needs block the page. The heavier history data
  // streams in its own boundary (below), so the greeting + quick actions paint immediately
  // on navigation instead of waiting on the listen-history aggregates. (Library stats moved
  // to the Playlists page heading.)
  const [playlists, meId, syncedAt, backupPref] = await Promise.all([
    getStoredPlaylists(),
    getMeId(),
    getPlaylistsSyncedAt(),
    getCleanBackupPref(),
  ]);

  return (
    <div>
      <header>
        <GreetingHeading initial={greeting} />
      </header>

      {/* Roomy gap below the greeting, then a tight, balanced gap around the divider so the
          history table below can claim the vertical space. */}
      <div className="mt-7">
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
          syncedAt={syncedAt}
        />
      </div>

      {/* History lives here now (the standalone /history route was removed) — no "See stuff"
          heading, so it flows straight out of the actions. Streamed so it never blocks the
          shell; the divider keeps a tight, balanced gap (mt = pt). */}
      <section className="mt-5 border-t border-border/60 pt-5">
        <Suspense fallback={<HistorySkeleton />}>
          <HomeHistory />
        </Suspense>
      </section>
    </div>
  );
}

// The listen-history aggregates (day stats, all-time, today's plays, search seed) live in
// their own async boundary so they stream after the shell rather than blocking navigation.
async function HomeHistory() {
  const tz = await tzOffsetMinutes();
  const [daily, allTime, initialResults] = await Promise.all([
    getDailyStats(tz),
    getAllTimeStats(),
    // Small seed only — it's replaced the moment you type, and a 300-row payload bloats the
    // streamed RSC for no visible benefit.
    searchHistory("", 50),
  ]);
  // Default to the most recent day with plays. Find's "last played" rows focus a specific
  // day/song via a client event (no URL params) — handled in HistoryClient, not here.
  const initialDay = daily[0]?.day ?? null;
  const initialDayTracks = initialDay ? await getPlaysByDay(initialDay, tz) : [];
  // Can the day strip expand past the first 2 weeks? (Are there older days?)
  const oldestShown = daily[daily.length - 1]?.day;
  const initialHasMoreDays =
    !!oldestShown && daily.length >= 14 && (await hasPlaysBeforeDay(oldestShown, tz));

  return (
    <HistoryClient
      initialDaily={daily}
      initialDay={initialDay}
      initialDayTracks={initialDayTracks}
      allTime={allTime}
      initialResults={initialResults}
      initialHasMoreDays={initialHasMoreDays}
      songListMaxHeightClass="sm:max-h-[calc(100vh-34rem)]"
    />
  );
}

// Placeholder shown while the history boundary streams — matches the day strip + table
// footprint so the shell doesn't jump when the real content lands.
function HistorySkeleton() {
  return (
    <div className="space-y-6">
      {/* Equal-width cards filling the full row, so the rightmost is flush with the table
          skeleton below (fixed-width boxes stopped short of the right edge). */}
      <div className="flex w-full gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-[7.5rem] flex-1 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[calc(100vh-36.25rem)] min-h-40 w-full rounded-lg" />
    </div>
  );
}
