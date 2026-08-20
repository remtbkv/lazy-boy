// The optimistic play handoff: the moment a song leaves the now-playing bar, it appears
// in today's list — same React update, no waiting for the sync round trip. These are the
// pure merge rules, kept import-free so a plain node run can known-answer test them.
//
// A provisional play is created client-side from the bar's own state (the client watched
// the song play; nothing about that needs a server). It is reconciled against server rows
// when a refresh lands: confirmed (a server row for the same song, played at/after the
// provisional time minus a grace window) → the server row wins; unconfirmed → the
// provisional is RE-APPLIED until it expires, so a sync that hasn't caught the play yet
// can't make the row flicker out. Spotify only records plays that ran ≥30s, so callers
// gate on observed progress — an early skip never gets a provisional row at all.

export type PlayRow = {
  id: string;
  name: string;
  artist: string;
  uri: string;
  album: string | null;
  albumImage: string | null;
  durationMs: number | null;
  plays: number;
  lastPlayed: string;
  firstPlayed: string;
  source: string | null;
};

/** `day` = the local day the play was minted for. Reconciliation must not credit it to a
 *  different day's card — a provisional minted at 11:59 PM used to be bumped onto the NEW
 *  day after midnight (wave-2 audit, A3).
 *  `basePlays` = the song's TODAY count in the view at mint time. Confirmation is the
 *  count going up — the one signal that actually means "the sync recorded my play".
 *  Timestamp windows can't do this job: Spotify stamps played_at at track START (settled
 *  empirically 2026-08-19 — a play's store row existed while the track was still
 *  playing), so the finished play's row timestamp is ~a song-length before the mint, and
 *  no scalar grace both rejects the previous play and accepts this one (wave-3
 *  independent suite, A1/A2 — the two documented jobs of the old graceMs were
 *  contradictory). */
export type Provisional = { row: PlayRow; at: number; day: string; basePlays: number };

/** How long an unconfirmed provisional keeps being re-applied before it is presumed a
 *  play Spotify never recorded. Sync attempts run every ~4s–2min while the tab is open,
 *  so five minutes is several chances to confirm. */
export const PROVISIONAL_TTL_MS = 5 * 60 * 1000;

const identity = (name: string, artist: string) =>
  `${artist.toLowerCase()}\n${name.toLowerCase()}`;

/** Fold one provisional play into a day's (per-song grouped) rows: an existing row for
 *  the song gains a play and the new timestamp; a new song gets a fresh row. Pure —
 *  returns a new array. */
export function addPlay(rows: PlayRow[], prov: PlayRow): PlayRow[] {
  const key = identity(prov.name, prov.artist);
  const at = rows.findIndex((r) => identity(r.name, r.artist) === key);
  if (at < 0) return [prov, ...rows];
  const merged = [...rows];
  merged[at] = {
    ...merged[at],
    plays: merged[at].plays + 1,
    // Newest-wins: unconditionally taking the provisional's stamp could move a row's
    // timestamp BACKWARDS when the server row is already newer (the day list sorts on it).
    lastPlayed:
      Date.parse(prov.lastPlayed) >= Date.parse(merged[at].lastPlayed)
        ? prov.lastPlayed
        : merged[at].lastPlayed,
    source: prov.source ?? merged[at].source,
  };
  return merged;
}

/** Merge server truth with the still-unconfirmed provisionals, and prune the confirmed
 *  or expired ones from `provs` (returned second — the caller keeps that list). A
 *  provisional is confirmed when the server's TODAY row for the song shows MORE plays
 *  than it had when the provisional was minted (`basePlays`) — the count going up is
 *  the direct signal "the sync recorded my play". A repeat play can't be swallowed by
 *  the previous play (that one was already in basePlays), and no timestamp arithmetic
 *  is involved (see the Provisional docstring for why time windows were unsound). */
export function reconcilePlays(
  serverRows: PlayRow[],
  provs: Provisional[],
  now: number,
): { rows: PlayRow[]; remaining: Provisional[] } {
  const remaining: Provisional[] = [];
  let rows = serverRows;
  for (const p of provs) {
    if (now - p.at > PROVISIONAL_TTL_MS) continue; // expired: presumed never recorded
    const key = identity(p.row.name, p.row.artist);
    const server = serverRows.find((r) => identity(r.name, r.artist) === key);
    const confirmed = (server?.plays ?? 0) > p.basePlays;
    if (confirmed) continue;
    rows = addPlay(rows, p.row);
    remaining.push(p);
  }
  return { rows, remaining };
}
