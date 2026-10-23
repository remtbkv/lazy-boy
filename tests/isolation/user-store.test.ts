// T1 (PLAN.md §6.4): every method of UserStore, as A then as B, over the harness's three files:
// app.db, whose users rows name A's and B's files, and those two files. Each store is the one a
// request gets: the identity read names the user's file, then forUser(uid). Each method must
// leave the other user's database and app.db byte for byte (an ordered dump of every table) and
// return no other-user marker; its positive control is that a write changes its own user's
// database and a marker read returns its own user's marker. The fixture registry has one entry
// per method: a method with no fixture fails the suite.
import { beforeAll, describe, expect, it } from "vitest";
import { forUserAt, type UserStore } from "@/lib/db";
import {
  A,
  B,
  PLAY_DAY,
  dumpDb,
  nameDb,
  playOf,
  playlistOf,
  seedUser,
  signedIn,
  tagOf,
  trackOf,
  useUserFiles,
  type Tag,
} from "./user-dbs";

type Kind = "write" | "marker" | "read";
type Fixture = { kind: Kind; call: (s: UserStore, tag: Tag) => Promise<unknown>; why?: string };

const FIXTURES: Record<string, Fixture> = {
  acquireLock: { kind: "write", call: (s) => s.acquireLock("t1-lock", 60_000) },
  benchStore: { kind: "read", call: (s) => s.benchStore("core") },
  checkPlayedAtConvention: { kind: "write", call: (s) => s.checkPlayedAtConvention() },
  clearSpotifyTokens: { kind: "write", call: (s) => s.clearSpotifyTokens() },
  deletePlaylistFromDb: { kind: "write", call: (s) => s.deletePlaylistFromDb("pl-1") },
  findTrackWithPlaylists: { kind: "marker", call: (s, t) => s.findTrackWithPlaylists(`${t}-only-song-1`, `${t}-only-artist`) },
  getAllTimePlays: { kind: "marker", call: (s) => s.getAllTimePlays(10) },
  getAllTimeStats: { kind: "read", call: (s) => s.getAllTimeStats() },
  getCaptureHealth: { kind: "read", call: (s) => s.getCaptureHealth() },
  getCleanBackupPref: { kind: "read", call: (s) => s.getCleanBackupPref() },
  getContextName: { kind: "read", call: (s) => s.getContextName("spotify:playlist:pl-1"), why: "A's name, B's negative cache" },
  getContextsFullCheckAt: { kind: "read", call: (s) => s.getContextsFullCheckAt() },
  getDailyStats: { kind: "read", call: (s) => s.getDailyStats(0, 30) },
  getHarvestGate: { kind: "read", call: (s) => s.getHarvestGate() },
  getHealthMarks: { kind: "read", call: (s) => s.getHealthMarks() },
  getHistoryIndex: { kind: "marker", call: async (s) => s.getHistoryIndex(await s.getHistoryIndexVersion()) },
  getHistoryIndexVersion: { kind: "read", call: (s) => s.getHistoryIndexVersion() },
  getHomePayload: { kind: "marker", call: (s) => s.getHomePayload() },
  getLastSync: { kind: "read", call: (s) => s.getLastSync() },
  getLibraryIndex: { kind: "marker", call: async (s) => s.getLibraryIndex(await s.getLibraryIndexVersion()) },
  getLibraryIndexVersion: { kind: "read", call: (s) => s.getLibraryIndexVersion() },
  getLibraryScanAttemptAt: { kind: "read", call: (s) => s.getLibraryScanAttemptAt() },
  getLibrarySyncedAt: { kind: "read", call: (s) => s.getLibrarySyncedAt() },
  getLibraryTracks: { kind: "marker", call: (s) => s.getLibraryTracks() },
  getLikedSignals: { kind: "read", call: (s) => s.getLikedSignals() },
  getMeId: { kind: "marker", call: (s) => s.getMeId() },
  getPlaylistSnapshot: { kind: "marker", call: (s) => s.getPlaylistSnapshot("pl-1") },
  getPlaylistsSyncedAt: { kind: "read", call: (s) => s.getPlaylistsSyncedAt() },
  getPlaylistTrackOrder: { kind: "marker", call: (s) => s.getPlaylistTrackOrder("pl-1") },
  getPlaylistTracks: { kind: "marker", call: (s) => s.getPlaylistTracks("pl-1") },
  getPlaysByDay: { kind: "marker", call: (s) => s.getPlaysByDay(PLAY_DAY, 0) },
  getSavedSyncedAt: { kind: "read", call: (s) => s.getSavedSyncedAt() },
  getSpotifyTokens: { kind: "marker", call: (s) => s.getSpotifyTokens() },
  getStoredPlaylist: { kind: "marker", call: (s) => s.getStoredPlaylist("pl-1") },
  getStoredPlaylists: { kind: "marker", call: (s) => s.getStoredPlaylists() },
  getUniqueSongCount: { kind: "read", call: (s) => s.getUniqueSongCount() },
  getUserTzOffset: { kind: "read", call: (s) => s.getUserTzOffset() },
  hasHomePayload: { kind: "read", call: (s) => s.hasHomePayload() },
  hasPlaysBeforeDay: { kind: "read", call: (s) => s.hasPlaysBeforeDay("2030-01-01", 0) },
  ledgerSyncCall: { kind: "read", call: (s) => s.ledgerSyncCall("t1", 1), why: "writes the telemetry store only" },
  maybeRecomputeAllTimeStats: {
    kind: "read",
    call: (s) => s.maybeRecomputeAllTimeStats(),
    why: "throttled: the seed's own recompute is under 10 minutes old",
  },
  playedTracksInContext: { kind: "marker", call: (s) => s.playedTracksInContext("spotify:playlist:pl-1") },
  rebuildHomePayload: { kind: "write", call: (s) => s.rebuildHomePayload() },
  recomputeAllTimeStats: { kind: "write", call: (s) => s.recomputeAllTimeStats() },
  recomputeUniqueSongCount: { kind: "read", call: (s) => s.recomputeUniqueSongCount(), why: "rewrites the value the seed wrote" },
  recordContexts: { kind: "write", call: (s, t) => s.recordContexts([{ uri: "spotify:album:x", name: `${t}-only-album-ctx`, type: "album" }]) },
  recordPlays: { kind: "write", call: (s, t) => s.recordPlays([playOf(t, 5, 10)]) },
  releaseLock: { kind: "read", call: (s) => s.releaseLock("not-held", "nobody"), why: "a lock nobody holds" },
  removeCachedPlaylistTrack: { kind: "write", call: (s) => s.removeCachedPlaylistTrack("pl-1", "spotify:track:t1") },
  searchHistory: { kind: "marker", call: (s) => s.searchHistory("") },
  setContextsFullCheckAt: { kind: "write", call: (s) => s.setContextsFullCheckAt() },
  setHarvestGate: { kind: "write", call: (s) => s.setHarvestGate({ lastActive: 1, lastHarvest: 2 }) },
  setHealthMark: { kind: "write", call: (s) => s.setHealthMark("daily_at", "1") },
  setLibraryScanAttemptAt: { kind: "write", call: (s) => s.setLibraryScanAttemptAt() },
  setLibrarySyncedAt: { kind: "write", call: (s) => s.setLibrarySyncedAt() },
  setSpotifyTokens: { kind: "write", call: (s, t) => s.setSpotifyTokens({ accessToken: `${t}-only-at2`, refreshToken: `${t}-only-rt2`, expiresAt: 1 }) },
  setUserTzOffset: { kind: "write", call: (s) => s.setUserTzOffset(-300) },
  storePlaylists: { kind: "write", call: (s, t) => s.storePlaylists([playlistOf(t, "pl-2")], `${t}-only-me`) },
  storePlaylistTracks: { kind: "write", call: (s, t) => s.storePlaylistTracks("pl-1", [trackOf(t, 6)], `${t}-only-snap2`) },
  storeSavedTracks: { kind: "write", call: (s, t) => s.storeSavedTracks([trackOf(t, 7)]) },
  unresolvedContextUris: { kind: "read", call: (s) => s.unresolvedContextUris() },
  unseenContexts: { kind: "read", call: (s) => s.unseenContexts([{ uri: "spotify:playlist:pl-1", type: "playlist" }]) },
  upsertStoredPlaylist: { kind: "write", call: (s, t) => s.upsertStoredPlaylist(playlistOf(t, "pl-3")) },
};

const BOUND = new Set(["uid", "dbName", "storeEpoch"]);
let n = 0;

beforeAll(() => {
  useUserFiles();
});

/** A fresh pair of seeded databases, one per user, each named by its user's users row and
 *  reached through that user's identity read. */
async function pair(): Promise<{ a: UserStore; b: UserStore; aDb: string; bDb: string }> {
  n++;
  const aDb = `u1-${n}`;
  const bDb = `u2-${n}`;
  await nameDb(A, aDb);
  await nameDb(B, bDb);
  const a = await signedIn(A);
  const b = await signedIn(B);
  expect([a.dbName, b.dbName]).toEqual([aDb, bDb]);
  await seedUser(a, "A");
  await seedUser(b, "B");
  return { a, b, aDb, bDb };
}

describe("T1: every UserStore method touches only its own user's database", () => {
  it("has a fixture for every method and none for a method that is gone", () => {
    const methods = Object.keys(forUserAt(A, "census")).filter((k) => !BOUND.has(k)).sort();
    expect(methods).toEqual(Object.keys(FIXTURES).sort());
  });

  for (const [name, fx] of Object.entries(FIXTURES)) {
    for (const actor of [A, B]) {
      const me = tagOf(actor);
      const other: Tag = me === "A" ? "B" : "A";
      it(`${name} as ${me}`, async () => {
        const { a, b, aDb, bDb } = await pair();
        const [mine, mineDb, theirsDb] = actor === A ? [a, aDb, bDb] : [b, bDb, aDb];
        const theirsBefore = await dumpDb(theirsDb);
        const mineBefore = await dumpDb(mineDb);
        const appBefore = await dumpDb("app");
        const out = JSON.stringify((await fx.call(mine, me)) ?? null);
        expect(await dumpDb(theirsDb), `${name} as ${me} changed ${other}'s database`).toBe(theirsBefore);
        expect(await dumpDb("app"), `${name} as ${me} changed the app database`).toBe(appBefore);
        expect(out.includes(`${other}-only`), `${name} as ${me} returned ${other}'s data: ${out.slice(0, 200)}`).toBe(false);
        if (fx.kind === "write") {
          expect(await dumpDb(mineDb), `${name} as ${me} wrote nothing of its own (positive control)`).not.toBe(mineBefore);
        }
        if (fx.kind === "marker") {
          expect(out.includes(`${me}-only`), `${name} as ${me} returned none of its own data (positive control)`).toBe(true);
        }
      });
    }
  }
});
