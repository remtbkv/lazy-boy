// The day lists Home derives from the history payload, extracted from den-home so the
// grouping logic is a pure, known-answer-testable function (2026-08-19 audit wave 3 —
// this derivation carried several of the audit's subtlest findings, and a pure module is
// the only way to pin them with executed tests). No React, no network, no globals except
// the timezone offset, which callers may inject.

import type { TrackStats } from "@/lib/db";

/** The history payload's wire shape. Kept as tuples for size — see db.ts readHistoryIndex
 *  for what each slot means. */
export type HistoryPayload = {
  images: string[];
  albums: string[];
  sources: string[];
  /** [name, artist, image, album, durationMs] — durationMs is 0 when unknown. */
  tracks: [string, string, number, number, number][];
  plays: [number, number, number][];
};

export type MemoryDays = {
  rows: Map<string, TrackStats[]>;
  /** One row PER PLAY, newest first, per-play source — the phone's day list shows a song
   *  again for each play instead of a count (Rem, 2026-08-13). Includes the newest day:
   *  the refresh patches new plays into the payload, so it stays current. */
  playRows: Map<string, TrackStats[]>;
  /** The local day of the newest play in the payload. Days strictly older than this are fully
   *  covered; that day itself may be missing the last few minutes (the payload rebuilds at
   *  most every 10 min — db.ts's slow marker), so it is left to the server path. */
  newest: string | null;
};

/** Epoch minutes (what the payloads carry) → the ISO string the formatters take. */
export function iso(minute: number): string {
  return new Date(minute * 60000).toISOString();
}

export function buildDays(
  hist: HistoryPayload,
  // Minutes to ADD to UTC, i.e. the same number TimezoneCookie writes for the server to
  // use. Defaults to the runtime's current offset; tests inject a fixed one.
  offsetMin: number = -new Date().getTimezoneOffset(),
): MemoryDays {
  const offMs = offsetMin * 60000;
  const localDay = (minute: number) => new Date(minute * 60000 + offMs).toISOString().slice(0, 10);
  // The "From" a day row shows is the song's most recent play OVERALL, not its last play that
  // day: SELECT_TRACK's source subquery (db.ts) is not filtered to the day, and TrackStats
  // says so in as many words. Reproduced rather than corrected, because the alternative is the
  // same day reading differently depending on which path produced its rows — and the first
  // seconds of every visit are still the server's. Plays arrive newest-first, so the first one
  // seen for a song is its latest. (Checked against getPlaysByDay over all 69 days in the
  // store, 2026-08-11: per-day source instead of this disagreed on 66 of them.)
  // Keyed by IDENTITY, not track index: payloads can hold one song under two Spotify ids,
  // and an index-keyed map gave each id-half its own "latest" — the rule says the SONG's
  // most recent play overall (wave-3 independent suite, B; same defect class as T2.5).
  const identityOf = (t: number): string | null => {
    const track = hist.tracks[t];
    return track ? `${track[1].toLowerCase()}\n${track[0].toLowerCase()}` : null;
  };
  const latestSource = new Map<string, number>();
  for (const [t, , src] of hist.plays) {
    const key = identityOf(t);
    if (key !== null && !latestSource.has(key)) latestSource.set(key, src);
  }
  const days = new Map<string, Map<string, TrackStats>>();
  const playRows = new Map<string, TrackStats[]>();
  for (const [t, minute, playSrc] of hist.plays) {
    const track = hist.tracks[t];
    if (!track) continue;
    const [name, artist, img, alb, durationMs] = track;
    const day = localDay(minute);
    {
      // The per-play row: this play's own time and its own context.
      let list = playRows.get(day);
      if (!list) playRows.set(day, (list = []));
      const played = iso(minute);
      list.push({
        // The per-play list position disambiguates dual-id plays of one song in one
        // minute — identity@minute alone collided as a React key (wave-3 suite, D).
        id: `${artist.toLowerCase()}\n${name.toLowerCase()}@${minute}#${list.length}`,
        name,
        artist,
        uri: "",
        album: alb >= 0 ? (hist.albums[alb] ?? null) : null,
        albumImage: img >= 0 ? (hist.images[img] ?? null) : null,
        durationMs: durationMs || null,
        plays: 1,
        lastPlayed: played,
        firstPlayed: played,
        source: playSrc >= 0 ? (hist.sources[playSrc] ?? null) : null,
      });
    }
    let rows = days.get(day);
    if (!rows) days.set(day, (rows = new Map()));
    const key = `${artist.toLowerCase()}\n${name.toLowerCase()}`;
    const played = iso(minute);
    const hit = rows.get(key);
    if (hit) {
      // Plays arrive newest-first, so the row was created from the day's LAST play — its time
      // is already right, and every later play can only push firstPlayed back.
      hit.plays += 1;
      hit.firstPlayed = played;
      continue;
    }
    const src = latestSource.get(key) ?? -1;
    rows.set(key, {
      // The identity IS the id here: the payload carries no track ids (it is joined on
      // identity — db.ts), and the only thing the day list uses `id` for is the React key.
      id: key,
      name,
      artist,
      uri: "",
      album: alb >= 0 ? (hist.albums[alb] ?? null) : null,
      albumImage: img >= 0 ? (hist.images[img] ?? null) : null,
      durationMs: durationMs || null,
      plays: 1,
      lastPlayed: played,
      firstPlayed: played,
      source: src >= 0 ? (hist.sources[src] ?? null) : null,
    });
  }
  const rows = new Map<string, TrackStats[]>();
  for (const [day, byKey] of days) {
    rows.set(
      day,
      [...byKey.values()].sort(
        (a, b) => b.plays - a.plays || b.lastPlayed.localeCompare(a.lastPlayed),
      ),
    );
  }
  // Plays arrive newest-first, so each day's per-play list is already newest-first.
  // `newest` from the first play whose track REF RESOLVES — an unresolvable head play
  // named a frontier day the payload holds no rows for (wave-3 suite, C).
  const firstResolved = hist.plays.find(([t]) => hist.tracks[t]);
  return { rows, playRows, newest: firstResolved ? localDay(firstResolved[1]) : null };
}
