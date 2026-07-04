"use server";

import { auth } from "@/lib/auth";
import {
  getAllTimePlays,
  getDailyStats,
  getPlaysByDay,
  searchHistory,
  type DayStats,
  type TrackStats,
} from "@/lib/db";
import { tzOffsetMinutes } from "@/lib/tz";

// Draft data actions — DB reads only, no Spotify. Same gate as the draft layout:
// open in dev, session-required in production (the data is personal).
async function allowed(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  return !!(await auth());
}

/** Tracks for one local day — the client caches per day, so each day costs one call. */
export async function dayTracksAction(day: string): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const tz = await tzOffsetMinutes();
  return getPlaysByDay(day, tz);
}

/** Older day stats — the strip starts with the recent window and extends on demand. */
export async function dailyStatsAction(days: number): Promise<DayStats[]> {
  if (!(await allowed())) return [];
  const tz = await tzOffsetMinutes();
  return getDailyStats(tz, Math.min(days, 100000));
}

/** Most-played all-time — fetched on demand when the All time view is opened. */
export async function allTimePlaysAction(): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  return getAllTimePlays(300);
}

/** Full-history search (name or artist, SQL LIKE) — every play as its own row,
 *  newest first; the client groups per song/artist. */
export async function searchPlaysAction(query: string): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  const q = query.trim();
  if (!q) return [];
  return searchHistory(q, 500);
}
