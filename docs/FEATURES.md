# FEATURES.md — ported features & algorithms

Specifications for every feature, ported from the Flask/Django + `PlaylistManager.py`
prototype. This is the source of truth for behavior; implementation lives in
`src/lib/spotify/domain.ts` (pure logic) and the feature routes/actions.

## Track identity & dedupe key

Throughout the app a track is normalized to:

```ts
type Track = { id: string; artist: string; title: string; uri: string }
```

- `artist` = the **first/primary** artist's name.
- The **dedupe key** is `(artist, title)` (NOT the Spotify id) — this is how the prototype
  treats "the same song" across different releases/albums. Two tracks with the same primary
  artist + title are considered duplicates even if their ids differ.
- Episodes, local files, and tracks with no id are excluded when reading.
- Known limitation (carried over): remixes/acoustic/live versions share a title → treated as
  the same song. Same title by different primary artists → treated as different. Good enough;
  do not "fix" without a request.

## Implemented features

### 1. List playlists
Get the user's playlists, sorted by name (case-insensitive). Optionally filter to
"only mine" (owner == current user). Endpoint: `GET /v1/me/playlists` (paginated).

### 2. View playlist
Show a playlist's tracks with album art, title, artists. `GET /v1/playlists/{id}` +
paginate `tracks`.

### 3. Merge playlists  →  `mergePlaylists(sources)`
Create one new private playlist from N sources, concatenated **in order**, with duplicates
removed by `(artist, title)`. First occurrence wins. New playlist name = `"A + B + C"`.
Reference: `PlaylistManager.merge_playlists`.

### 4. Clean playlist  →  `cleanPlaylist(target, library)`  [LONG-RUNNING]
Create `"Cleaned: {name}"` containing the target's tracks **minus any track already saved
elsewhere** in the user's library (liked songs + all the user's other playlists).
- "Already saved" = `(artist, title)` present in the union of the rest of the library.
- **Other `Cleaned: …` playlists count as library** — they're real playlists you listen to,
  so a song kept in an earlier clean is purged from later ones (first clean wins, so the
  same song never lives in two cleaned playlists). The one carve-out is the target's *own*
  output `Cleaned: {name}`, which is excluded because it holds exactly the songs this clean
  keeps (counting it would make the reconcile pass empty the playlist). Backups
  (`Dupes removed from: …`) are discard piles and never count. See `db.getLibraryTracks`.
- Removed tracks can optionally be backed up to `"Dupes removed from: {name}"`.
- This scans the entire library, so it runs as a **background task** with progress
  (processed / total) polled by the client. See `src/lib/tasks/`.
Reference: `PlaylistManager.clean_out_playlist`.

### 5. Save queue  →  `saveQueue()`  [PLAYBACK, PREMIUM]
Persist the user's current playback queue to a `"Saved queue"` playlist. Spotify exposes the
queue read via `GET /v1/me/player/queue` (the prototype predates this and walked the queue by
skipping tracks — we use the real endpoint). Captures up to 100 items. Requires an active
device and Premium. Reference: `PlaylistManager.save_queue`.

### 6. Liked songs as playlist  →  `syncLikedToPlaylist()`
Maintain a `"Liked songs as playlist"` playlist that exactly mirrors the user's liked songs.
Replaces the playlist's items with the current liked set. Reference: `liked_songs_as_playlist`.

### 7. Compare another user's playlists  →  `comparePlaylists(theirs, mine)`  [HIGH PRIORITY]
Given another user's public profile, for each of their playlists split tracks into:
- **Unsaved** — `(artist, title)` not in my library.
- **Saved** — already in my library.
Lets me save the "unsaved" set as a new playlist (song diff). Read-only on their account.
Reference: prototype's compare/unique/similar views + `load_playlist_from_profile`.

### 8. Find duplicates  →  `findDuplicates(tracks)`
Within a single playlist, list tracks whose `(artist, title)` appears more than once.
Reference: `check_playlist_for_duplicates`.

### 9. Remove songs  →  `removeTracks(playlist, ids)`
Create a new playlist = the original minus a given set of track ids. Reference:
`remove_songs_from_playlist`.

### 10. Subtract playlists  →  `subtractPreviewAction(base, others)`
Set difference between the user's own playlists, as a quick action. Pick a **base**
playlist and one or more playlists to subtract; the base's tracks split into:
- **Unique** — `(artist, title)` in no subtracted playlist (`subtract`).
- **Shared** — also present in a subtracted playlist (`intersect`), each tagged with the
  first subtracted playlist that contains it.
From the preview: save the unique set as a new playlist named `"A − B − C"`
(`createFromUris`). Reads the synced index — instant, and as fresh as the last library
sync, like Clean's phase 1; the preview recomputes live (debounced) as the selection
changes.

## Listen-history quick actions (added after the port)

These aren't from the prototype; they're built on the local listen-history store (`db.ts`).
Stats/sync internals live in [ARCHITECTURE](ARCHITECTURE.md) and [GOTCHAS](GOTCHAS.md).

### History search  →  the client-side index + `playsForTracksAction` + `SearchIsland`
The bottom search pill on Home searches the whole listen history by song title or artist; the
client groups the matches per song or per artist behind the songs/artists switch. DB-only — it
never calls Spotify, and album art is the URL already stored on the track row, so typing can't
cost API calls or hit a rate limit.

**Matching runs in the browser.** `/api/history/search-index` serves every played track as
`[id, name, artist]` (2,957 tracks, 108 KB gzipped), fetched once on first focus of the box and
filtered in memory, so a keystroke costs no network — it used to run `LIKE '%q%'` over the whole
history per keystroke (1,904 ms median against the primary; db.ts "The client-side search
index"). The index carries no stats, so rows appear instantly with title + artist and one
debounced `playsForTracksAction` call fills in counts, times and art for the matched ids alone.
While the index is still loading (or if it failed) `searchPlaysAction` answers instead, so the
box is never dead.

(The older **Find** panel — "which playlists contain this song" — and its `/api/find*` routes
and FTS5 trigram index were removed in `045d4a1`.)

### Resume  →  `resumePlaylistAction`  [PLAYBACK, PREMIUM]
"Pick up where you left off" in a playlist, assuming in-order (non-shuffled) listening:
- Scope the playlist's plays to the **most recent session** (a >3 h gap starts a new session),
  so an older, deeper run can't push the resume point past where you actually stopped.
- Within that session, take the end of the **longest in-order run** (small skips tolerated), so
  one accidental deep tap doesn't skip you ahead.
- Resume at the next track; if the run already reached the end, start from the top.
- Match plays to playlist positions by id, then fall back to **`(name, artist)`** — Spotify
  hands the same song different ids in a playlist vs. recently-played (see [GOTCHAS → Spotify
  Web API](GOTCHAS.md)), and an id-only match would drop those plays and resume too early. This
  is the same `(artist, title)` identity the dedupe/clean features use.

## Pure domain functions (src/lib/spotify/domain.ts)

All operate on `Track[]` and return `Track[]` / ids — no I/O:

- `dedupeByKey(tracks)` — keep first occurrence per `(artist, title)`.
- `mergeUnique(lists)` — concat in order, then `dedupeByKey`.
- `subtract(tracks, others)` — tracks whose key is NOT in `others`' key set.
- `intersect(tracks, others)` — tracks whose key IS in `others`' key set.
- `findDuplicateKeys(tracks)` — keys (and the extra occurrences) appearing >1 time.
- `keyOf(track)` — `` `${artist.toLowerCase()}\x00${title.toLowerCase()}` ``.

Keeping these pure makes the whole app testable without hitting Spotify.

## Rate limiting (must respect)

The prototype hit "mysterious rate limits". The client layer (`src/lib/spotify/client.ts`)
handles 429 by reading the `Retry-After` header and backing off, and batches writes
(add/replace items) in chunks of 100. Don't issue unbatched bulk calls.

---

**Related:** [ARCHITECTURE](ARCHITECTURE.md) (where these algorithms sit in the layering) ·
[CONVENTIONS](CONVENTIONS.md) (the dedupe key) · [GOTCHAS → Spotify Web API](GOTCHAS.md)
(endpoint changes these specs depend on) · [ROADMAP](ROADMAP.md).
