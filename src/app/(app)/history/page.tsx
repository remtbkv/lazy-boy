import {
  getAllTimeStats,
  getDailyStats,
  getPlaysByDay,
  searchHistory,
} from "@/lib/db";
import { HistoryClient } from "@/components/history-client";

// Reads the local DB fresh on each request.
export const dynamic = "force-dynamic";

export default function HistoryPage() {
  const daily = getDailyStats();
  // Default the main list to the most recent day with plays ("today" in practice).
  const initialDay = daily[0]?.day ?? null;
  const initialDayTracks = initialDay ? getPlaysByDay(initialDay) : [];
  const allTime = getAllTimeStats();
  // Pre-rendered first page of the search list (only shown while searching).
  const initialResults = searchHistory("");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Listening history</h1>
        <p className="mt-1 text-muted-foreground">
          Logging statistics for the curious
        </p>
      </div>
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
