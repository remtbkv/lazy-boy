import { readFileSync } from "node:fs";
import path from "node:path";
import { auth } from "@/lib/auth";
import { getAllTimeStats, getDailyStats, getPlaysByDay } from "@/lib/db";
import { tzOffsetMinutes } from "@/lib/tz";
import { DenHome } from "./den-home";
import { DockLoader } from "./dock-loader";
import { LockViewport } from "./lock-viewport";

// Home. Reads the local store only
// (zero Spotify API calls), so iterating on it can never touch a rate limit.
//
// Load shape: `loading.tsx` gives the route an instant skeleton (that's what makes the page
// feel immediate — the first byte doesn't wait on any query), and then the WHOLE page lands
// in one piece. There is deliberately NO inner Suspense boundary: streaming the shell first
// and the history after made the page assemble itself on screen — title, then day cards,
// then the song list — which reads as choppy. One skeleton → one complete page is smoother
// than a fast-but-staggered reveal. Only the dock's playlist library loads in the background
// (nothing on screen shows it, so it can't cause a visible pop).
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

export default async function HomePage() {
  const [session, tz] = await Promise.all([auth(), tzOffsetMinutes()]);
  const name = session?.user?.name ?? "You";
  const [daily, allTime] = await Promise.all([getDailyStats(tz, 14), getAllTimeStats()]);
  // eslint-disable-next-line react-hooks/purity -- Server Component: per-request time is intended
  const todayLocal = new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10);
  // Serial by necessity: which day to open depends on which days have plays.
  const initialDay = daily[0]?.day ?? todayLocal;
  const initialTracks = await getPlaysByDay(initialDay, tz);
  const first = name.split(" ")[0] || name;

  const greetings = loadGreetings();
  // Server Component: per-request randomness/time is intentional (matches /home).
  // eslint-disable-next-line react-hooks/purity
  const greeting = greetings[Math.floor(Math.random() * greetings.length)].replace("{name}", first);

  return (
    <>
      {/* Desktop: this page never scrolls — the song list inside absorbs the leftover height
          and scrolls on its own. The viewport lock lives on #den-root (see den.css) and is
          applied by <LockViewport /> only while Home is mounted, so the shared (app) layout
          stays scrollable for the Playlists grid. */}
      <LockViewport />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:overflow-hidden sm:px-6 sm:pb-[4.75rem] sm:pt-6">
        {/* Flex column that fills the available height on desktop so the whole page fits the
            viewport (no body scroll) and only the song list scrolls inside; on mobile it's a
            normal stacked column and the page scrolls. */}
        <div className="flex flex-col gap-6 sm:h-full sm:min-h-0">
          {/* Just the greeting — today's numbers already live on the Today card below,
              repeating them here said the same thing twice within an inch. */}
          <header className="shrink-0">
            <h1 className="den-display text-4xl leading-tight tracking-tight sm:text-5xl">
              {greeting}
            </h1>
          </header>

          <div className="shrink-0">
            <DockLoader />
          </div>

          <DenHome
            daily={daily}
            allTime={{ plays: allTime.plays, durationMs: allTime.durationMs, since: allTime.since }}
            initialDay={initialDay}
            initialTracks={initialTracks}
          />
        </div>
      </main>
    </>
  );
}
