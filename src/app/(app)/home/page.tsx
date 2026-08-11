import { readFileSync } from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getAllTimeStats,
  getDailyStats,
  getHomePayload,
  getPlaysByDay,
  rebuildHomePayload,
  type HomePayload,
} from "@/lib/db";
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

type HomeData = Pick<HomePayload, "daily" | "allTime" | "initialDay" | "initialTracks">;

/** The pre-payload data path, kept for the one case the payload can't cover: a store nothing
 *  has ever synced into (fresh DB, first deploy). Three reads in two-to-three sequential waves
 *  — the shape the payload exists to remove — so it also kicks off a rebuild, and the next
 *  load is a single read again. The rebuild is not awaited: this request already has its
 *  answer, and making the first visitor after a deploy wait on a write helps nobody. */
async function readHomeInline(): Promise<HomeData> {
  const tz = await tzOffsetMinutes();
  const [daily, allTime] = await Promise.all([getDailyStats(tz, 14), getAllTimeStats()]);
  const todayLocal = new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10);
  // Serial by necessity: which day to open depends on which days have plays.
  const initialDay = daily[0]?.day ?? todayLocal;
  const initialTracks = await getPlaysByDay(initialDay, tz);
  void rebuildHomePayload().catch((e) => {
    console.error("[home-payload] rebuild from render failed", e);
  });
  return { daily, allTime, initialDay, initialTracks };
}

export default async function HomePage() {
  // ONE read for everything below: the day strip, the all-time card and the opening day's
  // rows are materialized into a single meta row by the sync that last changed them (db.ts,
  // "The Home payload"). The page used to run those as two or three sequential query waves,
  // each paying a full round trip to the funnel-reached primary before any work started, to
  // recompute an answer that only moves when a sync writes.
  const [session, payload] = await Promise.all([auth(), getHomePayload()]);
  // Gate here, not just in the layout: Next renders layout and page in parallel, so the
  // layout's redirect alone still flushes this page's data into the 307 body (SECURITY.md).
  if (!session || session.error) redirect("/login");
  const name = session?.user?.name ?? "You";
  const { daily, allTime, initialDay, initialTracks } = payload ?? (await readHomeInline());
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-36 pt-7 sm:overflow-hidden sm:px-6 sm:pb-[4.75rem] sm:pt-6">
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
