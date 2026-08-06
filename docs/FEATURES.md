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

### Library search  →  the two search payloads + `SearchIsland`
The bottom search pill on Home searches your **library** — every song in a playlist, in Liked
Songs, or in the listen history — by title or artist; the client groups the matches per song or
per artist behind the songs/artists switch. DB-only — it never calls Spotify, and album art is
the URL already stored on the track row, so typing can't cost API calls or hit a rate limit.

**Matching runs in the browser, over two payloads** (db.ts, "The client-side search payloads"),
both fetched once on idle after Home mounts and filtered in memory, so a keystroke costs no
network. It used to run `LIKE '%q%'` over the whole history per keystroke — 1,904 ms median
against the primary.
- `/api/search/library` — every track in a playlist or in Liked Songs as
  `[name, artist, image, album, playlists]` (13,464 songs, 577 KB gzipped). This is the half
  that makes a never-played song findable. It changes only when a playlist does, so a repeat
  visit revalidates it in a 304 with no body.
- `/api/search/history` — every played song plus every individual play as
  `[track, minute, source]` (2,959 songs, 7,050 plays, 168 KB gzipped). Its version is the
  write marker, so it is re-fetched after any listening — which is why it is the small half.

The two are merged on the song's **identity**, `lower(artist) + lower(name)`, not on the track
id: Spotify hands the same song a different id in a playlist than in recently-played, so an id
join reports 338 of this store's played-and-in-a-playlist songs as never played
(`bench-reads.mjs search` counts it, and checks the client's verdict against SQL's).

Because the counts, times, playlists and per-play list all ride in the payloads, **a result row
is complete in the frame it appears** — nothing fills in behind it, and expanding a row costs no
request. A row that has never been played says so where its last-played time would be, and
expands to the playlists it sits in; a played row expands to every play, with the exact time and
**where it was played from** (the same per-play `source` the day table's From column shows —
`sourceExpr` in `db.ts`: the resolved playlist/album name, the context type when the name never
resolved, blank when the song is no longer in the playlist it was credited to). Results are
ranked exact title → prefix → substring, played before never-played, and capped at 400 with the
dropped count shown under the list.
While the payloads are still loading (or if both failed) `searchPlaysAction` answers instead, so
the box is never dead — it just answers over the history alone.

(The older **Find** panel — "which playlists contain this song" — and its `/api/find*` routes
and FTS5 trigram index were removed in `045d4a1`. The library payload answers the same question
inside a search result's expansion, without an index to maintain.)

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
