# Prep — Lazy Boy read model (facts only)

For `docs/fable/prompts/read-model.md`. **Facts, cited paths, no decisions and no ranking.**
Gathered 2026-08-01 by an Opus session on the execution account. Everything here is
re-derivable from the repo or the live DB; verify anything load-bearing before building on
it, and see §6 for the claims that are known-shaky.

Repo: `~/projects/lazyboy` (branch `main`). Live site `https://lazy-spotify.vercel.app`.

---

## 1 · Shape of the thing

Single-user Next.js 16 app over one person's Spotify account: playlists, liked songs, and a
listen history built by polling `/me/player/recently-played`.

Store is libSQL/Turso, one remote primary, `src/lib/db.ts` (1381 lines) is the entire data
layer. Row counts on the live DB, 2026-08-01:

| table | rows |
|---|---|
| `tracks` | 14,989 |
| `playlist_tracks` | 15,336 |
| `plays` | 6,650 |
| `playlists` | 180 |
| `contexts` | 73 |
| `saved_tracks` | 46 |
| `meta` | 367 |

DB file 17.3 MB / 4,225 pages, of which 2,100 are free (an FTS index was dropped 2026-08-01;
Turso rejects `VACUUM` over HTTP, so the freed pages are reused rather than returned).

Deploy: Vercel, Node 24, single region `iad1`, project `lazy-boy`. Vercel Functions get a
read-only FS with a writable `/tmp` up to 500 MB
(<https://vercel.com/docs/functions/runtimes>); production functions are archived after two
weeks without an invocation.

Observed live traffic (`vercel logs`, 2026-08-01 11:47–11:49): `GET /api/now-playing` every
6 s while the app is open, `POST /api/sync` on load, `GET /api/cron/sync` from an external
pinger. Whether that keeps a single instance resident is **not measured**.

## 2 · Primary artifacts — read these, not this file

| what | path |
|---|---|
| the whole data layer | `src/lib/db.ts` |
| the query-conventions block that governs new queries | `src/lib/db.ts` lines 21–38 |
| read-replica split (`getClient` / `getReader` / `syncReader`) | `src/lib/db.ts` ~176–260 |
| stored source verdict (`sourceExpr`, `ORPHAN_PREDICATE`, `recomputeOrphanFlags`) | `src/lib/db.ts` ~427–495 |
| history search | `src/lib/db.ts` `searchHistory`, `src/app/api/history/search/route.ts` |
| Home render | `src/app/(app)/home/page.tsx` |
| Home client, incl. search debounce + mount prefetch | `src/app/(app)/home/den-home.tsx` |
| server actions for history | `src/app/(app)/history-actions.ts` |
| the two syncs | `src/lib/sync/history.ts`, `src/lib/sync/library.ts` |
| accumulated repo lore | `docs/GOTCHAS.md`, `docs/ARCHITECTURE.md` |
| the two commits under discussion | `76e2c61`, `37af0ea` |

`.env.local` holds `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` and is gitignored.

## 3 · Every derived value in the store, and what keeps it current

Six mechanisms, six different invalidation stories. This is an inventory, not a ranking.

| derived value | computed | kept current by |
|---|---|---|
| listened-ms per play (gap to next play, capped at song length) | JS, per read, over an ordered scan | nothing — recomputed every time |
| per-day buckets (`getDailyStats`) | JS, per read, over a windowed scan | nothing — recomputed every time |
| `alltime_stats` (plays / unique / listened / since) | full `plays` scan | `recomputeAllTimeStats()` from `recordPlays` when ≥1 play is new |
| `unique_song_count` | `DISTINCT` over `playlist_tracks ⋈ tracks` | `recomputeUniqueSongCount()` at the end of a library sync |
| `plays.ctx_orphan` (is this play's track in its context playlist) | SQL predicate at write | `recomputeOrphanFlags()` from `recordPlays`, `storePlaylistTracks`, `deletePlaylistFromDb`, `storePlaylists` |
| the read replica itself | libSQL frame pull | `syncReader()` after each write + `syncInterval: 30` |

The last three are hand-maintained call-site lists. There is no test that recomputes any of
them from source and asserts equality; the equality checks that exist were run once, by hand,
during development (§5).

## 4 · Measurements — medians over repeated runs

**Read `SELECT 1` first.** Any per-query number below has to be read against it.

n=8, ms, median (min–max):

| | primary (remote Turso) | replica (local file) |
|---|---|---|
| `SELECT 1` | 46.9 (37.2–439.7) | 0.04 |
| `COUNT(*) tracks` (14,989) | 311.9 (166.5–452.4) | 0.02 |
| `COUNT(*) plays` (6,650) | 31.1 (28.4–164.7) | 0.02 |
| `COUNT(*) playlist_tracks` (15,336) | 201.7 (53.1–450.1) | 0.03 |
| `tracks` scan via `LIKE` (0 hits) | 476.8 (222.4–924.2) | 1.06 |

n=5, ms median, the user-visible read paths, before/after the stored-source change:

| query | primary before | primary after | replica before | replica after |
|---|---|---|---|---|
| history search `'the'` (424 rows) | 546.4 | 344.5 | 36.2 | 5.7 |
| all-time list, 300 | 902.8 | 704.5 | 62.6 | 8.9 |
| one day's plays (61 rows) | 40.5 | 40.6 | 1.7 | 0.9 |
| day-strip full scan, on Home mount (6,650 rows) | — | 105.1 | — | 13.0 |

Replica lifecycle: cold sync 2.4–4.6 s for a 17.4 MB file; incremental sync ~207 ms; a single
write forwarded through the replica 647 ms vs 116 ms direct to the primary; `recomputeOrphanFlags`
returns 0 rows in 211 ms (`newOnly`) / 409 ms (`playlistId`) in steady state.

## 5 · Verification that was actually run, and how

- **Replica vs primary, same process, alternating**: 8 read paths, identical row counts and
  identical serialised rows.
- **Stored `ctx_orphan` vs the live expression it replaced**: `SELECT COUNT(*) … WHERE (old)
  IS NOT (new)` over all 6,644 plays → **0 mismatches**; blank count 591 both ways.
- **Invalidation, on a throwaway local DB through the real `db.ts`**: play whose playlist is
  uncached → shows `"playlist"`; cache a playlist *without* it → `null`; cache one *with* it →
  `"playlist"` again.
- **Migration**: fresh DB, `ALTER TABLE plays ADD COLUMN ctx_orphan` path exercised, a play
  recorded and read back.
- `npx tsc --noEmit`, `npm run lint`, `npm run build` pass at `37af0ea`.

All of the above are one-off scripts, since deleted. Nothing is checked in; nothing re-runs.

**Not verified:** any authed page render in production, or on Vercel at all. The browser
profile available to the authoring session has no session cookie for the app, so no end-to-end
timing exists for a real `/home` render. The replica has never been observed running on Vercel
— only locally.

## 6 · Known-shaky claims

- **Timings in `src/lib/db.ts` comments predating 2026-08-01 are single-shot** and were taken
  against a backend that varies 3–10×: `"was ~4.5s"` (line ~147), `"INNER was 150ms–1.5s+
  here, LEFT is a steady ~50ms"` (~670), `"~3s for ~1.5k rows"` for the `LEAD()` window
  function (~523). The **query-conventions block at lines 21–38 is derived from those
  numbers** — drive joins from the indexed hot table, `LEFT` not `INNER`, no SQL window
  functions, cache aggregates in `meta`. None has been re-measured with repetition.
- The numbers reported in commit messages `76e2c61` and `37af0ea` are single-shot and read
  3–7× larger than the medians in §4. The comments in `db.ts` and `docs/GOTCHAS.md` were
  corrected to medians on 2026-08-01; **the commit messages were not** and still overstate.
- `~91%` of plays being non-orphan (a `db.ts` comment) is derived from 591/6,644 on one date.
- Turso plan/tier for `lazy-boy-remtbkv` is **unknown** — the `turso` CLI on this machine is
  not logged in.
- The claim that Vercel instances stay warm for this app is an inference from the 6-second
  now-playing poll, not a measurement.

## 7 · Constraints that are facts, not preferences

- `plays` is **irreplaceable**. `/me/player/recently-played` returns only the last 50 plays;
  anything not captured in the polling window is gone permanently.
- Spotify's PKCE refresh token **rotates on every use**. Tokens live in `meta.spotify_tokens*`
  and are read through the primary; a stale read races two instances into `invalid_grant` and
  a forced re-login. `acquireLock`/`releaseLock` (a TTL compare-and-set in `meta`) exist for
  this. Dev and prod use different `meta` keys (`spotify_tokens_dev` vs `spotify_tokens`) but
  the **same database**.
- The same song has **different track ids** in a playlist vs. in recently-played (Spotify
  relinking), so play↔playlist correlation matches on `(artist, title)`, not id.
- The Spotify app is in development mode: reading any other user's data returns 403.
- Turso bills row writes, including no-op `ON CONFLICT` updates; several existing code paths
  diff before writing specifically to avoid that (`src/lib/store-diff.ts`).
- `VACUUM` is rejected over the Turso HTTP protocol.
