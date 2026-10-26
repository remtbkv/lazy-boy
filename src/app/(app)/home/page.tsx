import { readFileSync } from "node:fs";
import path from "node:path";
import { auth } from "@/lib/auth";
import { readCapture } from "@/lib/capture-read";
import { forUser, type HomePayload, type UserStore } from "@/lib/db";
import { requirePageUser } from "@/lib/require-user";
import { tzOffsetMinutes } from "@/lib/tz";
import { DenHome } from "./den-home";
import { RateLimitNotice } from "./rate-limit-notice";
import { CaptureHealthNotice } from "./capture-health-notice";
import { DockLoader } from "./dock-loader";
import { LockViewport } from "./lock-viewport";
import { StableText } from "./stable-text";

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
async function readHomeInline(store: UserStore): Promise<HomeData> {
  const tz = await tzOffsetMinutes(store);
  const [daily, allTime] = await Promise.all([store.getDailyStats(tz, 14), store.getAllTimeStats()]);
  const todayLocal = new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10);
  // Serial by necessity: which day to open depends on which days have plays.
  const initialDay = daily[0]?.day ?? todayLocal;
  const initialTracks = await store.getPlaysByDay(initialDay, tz);
  void store.rebuildHomePayload().catch((e) => {
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
  // The gate runs FIRST and alone: the reads need its uid, so nothing is read for a caller it
  // refuses (multi-user PLAN §5.1; AUTHZ.md F8: the reads used to share a Promise.all with
  // auth(), so an anonymous request paid three store reads before its redirect). Gate here,
  // not just in the layout: Next renders layout and page in parallel, so the layout's
  // redirect alone still flushes this page's data into the 307 body (SECURITY.md).
  const user = await requirePageUser();
  const store = forUser(user.uid);
  // The payload read gets a catch: a transient store hiccup (cold funnel, sqld restart)
  // should fall through to the inline path — which retries the connection — rather than
  // crash the render into the error boundary (Rem's stale-tab morning refresh, 2026-08-15).
  // auth() again costs no store read: the identity check and the token read are per-request
  // boxes the gate's call already filled; it is here for the greeting's name.
  // The capture line and the cooldown that explains a pause come from the user's sync_state and
  // the recently-played bucket's cooldown, one app-database statement (multi-user PLAN §7.10).
  const [session, payload, capture] = await Promise.all([
    auth(),
    store.getHomePayload().catch(() => null),
    readCapture(user.uid).catch(() => null),
  ]);
  const cooldownUntil = capture?.rpCooldownUntil ?? 0;
  const captureHealth = capture?.health ?? null;
  const name = session?.user?.name ?? "You";
  const { daily, allTime, initialDay, initialTracks } = payload ?? (await readHomeInline(store));
  const first = name.split(" ")[0] || name;

  const greetings = loadGreetings();
  // Server Component: per-request randomness/time is intentional (matches /home).
  // eslint-disable-next-line react-hooks/purity
  const greeting = greetings[Math.floor(Math.random() * greetings.length)].replace("{name}", first);

  return (
    <>
      {/* This page never scrolls, at any width — the song list inside absorbs the leftover
          height and scrolls on its own, with the search pill always visible beneath it
          (phone shape per Rem's iMessage reference, 2026-08-12). The viewport lock lives on
          #den-root (see den.css) and is applied by <LockViewport /> only while Home is
          mounted, so the shared (app) layout stays scrollable for the Playlists grid. */}
      <LockViewport />
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-hidden px-4 pb-[calc(env(safe-area-inset-bottom)+4.75rem)] pt-5 sm:px-6 sm:pb-[4.75rem] sm:pt-6">
        {/* Flex column that fills the available height so the whole page fits the viewport
            (no body scroll) and only the song list scrolls inside. */}
        <div className="flex h-full min-h-0 flex-col gap-4 sm:gap-6">
          {/* Just the greeting — today's numbers already live on the Today card below,
              repeating them here said the same thing twice within an inch.
              den-home-band: folds away in the phone search mode (den.css). */}
          <header className="den-home-band shrink-0">
            <h1 className="den-display text-4xl leading-tight tracking-tight sm:text-5xl">
              <StableText text={greeting} />
            </h1>
          </header>

          <div className="den-home-band shrink-0">
            <DockLoader />
          </div>

          {/* eslint-disable-next-line react-hooks/purity -- per-request clock read, like the greeting */}
          <RateLimitNotice until={cooldownUntil > Date.now() ? cooldownUntil : 0} />
          {/* While Spotify's cooldown holds, the line above already says why nothing is landing. */}
          {/* eslint-disable-next-line react-hooks/purity -- per-request clock read, like the greeting */}
          <CaptureHealthNotice health={cooldownUntil > Date.now() ? null : captureHealth} />

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
