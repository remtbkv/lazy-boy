// Shared rig for the adversarial store suite. Nothing here asserts anything — it only
// gives each test a clean store and a raw window into it, so expectations can be stated
// against the DOCUMENTED rule rather than against whatever a reader happens to return.
//
// The raw client is a SECOND connection to the same throwaway file tests/setup.ts points
// TURSO_DATABASE_URL at. It exists to (a) truncate between tests and (b) read the stored
// `plays.skipped` verdicts directly, which no public reader exposes.
import { createClient, type Client } from "@libsql/client";
import { getLastSync, type PlayRecord } from "@/lib/db";
import type { Track } from "@/lib/spotify/types";

let raw: Client | null = null;

export async function rawClient(): Promise<Client> {
  // Forces db.ts's one-time init(), which is what creates the schema.
  await getLastSync();
  raw ??= createClient({ url: process.env.TURSO_DATABASE_URL as string, intMode: "number" });
  return raw;
}

const TABLES = [
  "plays",
  "tracks",
  "contexts",
  "meta",
  "playlists",
  "playlist_tracks",
  "saved_tracks",
  "usage_ledger",
  "api_log",
  "client_metrics",
];

export async function resetStore(): Promise<void> {
  const c = await rawClient();
  await c.executeMultiple(TABLES.map((t) => `DELETE FROM ${t};`).join("\n"));
}

export const DAY_MS = 86_400_000;
export const iso = (ms: number): string => new Date(ms).toISOString();

export function play(
  trackId: string,
  playedAt: string,
  durationMs: number | null,
  extra: Partial<PlayRecord> = {},
): PlayRecord {
  return {
    trackId,
    name: `Song ${trackId}`,
    artist: `Artist ${trackId}`,
    uri: `spotify:track:${trackId}`,
    album: `Album ${trackId}`,
    albumImage: null,
    durationMs,
    playedAt,
    contextType: null,
    contextUri: null,
    ...extra,
  };
}

export function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id,
    artist: `Artist ${id}`,
    title: `Song ${id}`,
    uri: `spotify:track:${id}`,
    album: `Album ${id}`,
    albumImage: null,
    durationMs: 200_000,
    addedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

/** The stored skip verdict of every play, keyed `trackId@playedAt`. null = pending. */
export async function verdicts(): Promise<Record<string, number | null>> {
  const c = await rawClient();
  const res = await c.execute(
    "SELECT track_id, played_at, skipped FROM plays ORDER BY played_at, track_id",
  );
  const out: Record<string, number | null> = {};
  for (const r of res.rows) {
    out[`${String(r.track_id)}@${String(r.played_at)}`] =
      r.skipped == null ? null : Number(r.skipped);
  }
  return out;
}

/** Raw (position, track_id) of a playlist's cached tracks, in reading order. */
export async function positions(
  playlistId: string,
): Promise<{ position: number; trackId: string }[]> {
  const c = await rawClient();
  const res = await c.execute({
    sql: "SELECT position, track_id AS trackId FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
    args: [playlistId],
  });
  return res.rows.map((r) => ({ position: Number(r.position), trackId: String(r.trackId) }));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
