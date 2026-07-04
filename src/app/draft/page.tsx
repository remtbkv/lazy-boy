import { readFileSync } from "node:fs";
import path from "node:path";
import { auth } from "@/lib/auth";
import {
  getAllTimeStats,
  getDailyStats,
  getPlaysByDay,
  getStoredPlaylists,
  searchHistory,
} from "@/lib/db";
import { formatListenTime } from "@/lib/format";
import { tzOffsetMinutes } from "@/lib/tz";
import { DenBottomNav, DenChrome } from "./chrome";
import { DenHome } from "./den-home";

// Design draft of the home page — real data, new skin. Reads the local store only
// (zero Spotify API calls), so iterating on it can never touch a rate limit.
export const dynamic = "force-dynamic";

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

export default async function DraftPage() {
  const [session, tz] = await Promise.all([auth(), tzOffsetMinutes()]);
  const name = session?.user?.name ?? "You";
  const image = session?.user?.image ?? null;
  const first = name.split(" ")[0] || name;

  const greetings = loadGreetings();
  // Server Component: per-request randomness/time is intentional (matches /home).
  // eslint-disable-next-line react-hooks/purity
  const greeting = greetings[Math.floor(Math.random() * greetings.length)].replace("{name}", first);
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const [daily, allTime, latest, playlists] = await Promise.all([
    getDailyStats(tz, 14),
    getAllTimeStats(),
    searchHistory("", 1), // just the most recent play, for the mark's asleep/awake state
    getStoredPlaylists(),
  ]);

  const today = new Date(now + tz * 60_000).toISOString().slice(0, 10);
  const initialDay = daily[0]?.day ?? today;
  const initialTracks = await getPlaysByDay(initialDay, tz);

  // The mark's the tell: awake while you're (likely) listening — most recent recorded
  // play within the sync cadence's horizon — asleep otherwise.
  const last = latest[0]?.lastPlayed ? Date.parse(latest[0].lastPlayed) : 0;
  const awake = now - last < 10 * 60_000;

  const todayStats = daily.find((d) => d.day === today);
  const subline = todayStats
    ? `${todayStats.plays} plays · ${formatListenTime(todayStats.durationMs)} today`
    : "Quiet so far today.";

  return (
    <>
      <DenChrome awake={awake} name={name} image={image} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-12 sm:pt-9">
        <DenHome
          greeting={greeting}
          subline={subline}
          daily={daily}
          allTime={{ plays: allTime.plays, durationMs: allTime.durationMs, since: allTime.since }}
          initialDay={initialDay}
          initialTracks={initialTracks}
          playlists={playlists}
        />
      </main>
      <DenBottomNav name={name} image={image} />
    </>
  );
}
