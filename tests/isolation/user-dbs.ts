// Per-user database files for the isolation suite (PLAN.md §6.4 "What the harness gains"): each
// test gets its own directory, STORE_URL_TEMPLATE points every db_name at a file in it, and the
// production open provisions each file for the uid that opens it first, so provisioning is under
// test too. Two users with deliberate collisions (the same track ids at the same played_at, the
// same playlist id with different members, the same context URI named for one and
// negative-cached for the other) carry a marker (`A-only-…`, `B-only-…`) in every text column.
// dumpDb is an ordered logical dump of every table, in place of a file hash, which WAL would fool.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { expect } from "vitest";
import { forUserAt, type PlayRecord, type StoredPlaylist, type UserStore } from "@/lib/db";
import { mintUid, type Uid } from "@/lib/identity";
import type { Track } from "@/lib/spotify/types";

export const A: Uid = mintUid("aaaaaaaaaaaa");
export const B: Uid = mintUid("bbbbbbbbbbbb");
export type Tag = "A" | "B";
export const tagOf = (uid: Uid): Tag => (uid === A ? "A" : "B");
export const FAR = 4_000_000_000;

/** A fresh directory for this test file's user databases; STORE_URL_TEMPLATE names it. */
export function useUserFiles(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lazyboy-users-"));
  process.env.STORE_URL_TEMPLATE = `file:${dir}/{db}.db`;
  return dir;
}

/** Every table of the database `dbName` names under the current template, rows sorted. */
export async function dumpDb(dbName: string): Promise<string> {
  const url = (process.env.STORE_URL_TEMPLATE as string).replaceAll("{db}", dbName);
  const c = createClient({ url, intMode: "number" });
  try {
    const t = await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const out: Record<string, string[]> = {};
    for (const row of t.rows) {
      const name = String(row.name);
      const r = await c.execute(`SELECT * FROM ${name}`);
      out[name] = r.rows.map((x) => JSON.stringify(x)).sort();
    }
    return JSON.stringify(out);
  } finally {
    c.close();
  }
}

// One clock for both users, so their plays collide on (track id, played_at).
const T0 = Date.UTC(2026, 9, 14, 18, 0, 0);
export const PLAY_DAY = new Date(T0 - 50 * 60_000).toISOString().slice(0, 10);
const at = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();

export function playOf(tag: Tag, n: number, minAgo: number): PlayRecord {
  return {
    trackId: `t${n}`,
    name: `${tag}-only-song-${n}`,
    artist: `${tag}-only-artist`,
    uri: `spotify:track:t${n}`,
    album: `${tag}-only-album`,
    albumImage: null,
    durationMs: 200_000,
    playedAt: at(minAgo),
    contextType: "playlist",
    contextUri: "spotify:playlist:pl-1",
  };
}

export function trackOf(tag: Tag, n: number): Track {
  return {
    id: `t${n}`,
    title: `${tag}-only-song-${n}`,
    artist: `${tag}-only-artist`,
    uri: `spotify:track:t${n}`,
    album: `${tag}-only-album`,
    albumImage: null,
    durationMs: 200_000,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function playlistOf(tag: Tag, id = "pl-1"): StoredPlaylist {
  return { id, name: `${tag}-only-playlist`, ownerId: `${tag}-only-me`, image: null, trackCount: 2 };
}

/** Fill a user's database through its own store. Both users end with the same counters
 *  (write_seq, library_seq), since they make the same writes. */
export async function seedUser(store: UserStore, tag: Tag): Promise<void> {
  await store.recordPlays([playOf(tag, 1, 60), playOf(tag, 2, 50), playOf(tag, 1, 40)]);
  // The same context URI: named for A, negative-cached (no name) for B.
  await store.recordContexts([{ uri: "spotify:playlist:pl-1", name: tag === "A" ? "A-only-ctx" : null, type: "playlist" }]);
  await store.storePlaylists([playlistOf(tag)], `${tag}-only-me`);
  // The same playlist id with different members.
  await store.storePlaylistTracks("pl-1", [trackOf(tag, 1), trackOf(tag, tag === "A" ? 2 : 3)], `${tag}-only-snap`);
  await store.storeSavedTracks([trackOf(tag, 4)]);
  await store.setSpotifyTokens({ accessToken: `${tag}-only-at`, refreshToken: `${tag}-only-rt`, expiresAt: FAR });
  await store.rebuildHomePayload();
  await store.recomputeUniqueSongCount();
}

/** The check the planted URL template must fail (planted-bugs.test.ts): A and B, each at their
 *  own db_name, are seeded; B's writes leave A's database as it was, and B reads back its own
 *  data and none of A's. A template that maps both names to one file fails it at B's open. */
export async function expectOwnDatabases(aDb: string, bDb: string): Promise<void> {
  const a = forUserAt(A, aDb);
  const b = forUserAt(B, bDb);
  await seedUser(a, "A");
  const before = await dumpDb(aDb);
  await seedUser(b, "B");
  expect(await dumpDb(aDb)).toBe(before);
  const seen = JSON.stringify(await b.searchHistory(""));
  expect(seen).toContain("B-only");
  expect(seen).not.toContain("A-only");
}
