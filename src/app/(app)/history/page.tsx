import {
  getAllTimeStats,
  getDailyStats,
  getPlaysByDay,
  searchHistory,
} from "@/lib/db";
import { tzOffsetMinutes } from "@/lib/tz";
import { HistoryClient } from "@/components/history-client";

// Reads the DB fresh on each request (also so the tz cookie is honoured).
export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const tz = await tzOffsetMinutes();
  const [daily, allTime, initialResults] = await Promise.all([
    getDailyStats(tz),
    getAllTimeStats(),
    // Pre-rendered first page of the search list (only shown while searching).
    searchHistory(""),
  ]);
  // Default the main list to the most recent day with plays ("today" in practice).
  const initialDay = daily[0]?.day ?? null;
  const initialDayTracks = initialDay ? await getPlaysByDay(initialDay, tz) : [];

  return (
    <div className="space-y-8">
      {/* The nav already says "History" — a single bigger heading, no subtitle. */}
      <h1 className="text-4xl font-bold tracking-tight">Listening history</h1>
      <HistoryClient
        initialDaily={daily}
        initialDay={initialDay}
        initialDayTracks={initialDayTracks}
        allTime={allTime}
        initialResults={initialResults}
      />
    </div>
  );
}
