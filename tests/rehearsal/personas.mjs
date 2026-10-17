// The rehearsal's three synthetic people (docs/multi-user/REHEARSAL.md): an admin standing in for
// Rem and two friends, A and B. Every string any of them owns carries its tag (`FRIENDA`, ...), as
// in tests/isolation/authz-harness.ts's `<OWNER>-only-` markers, so a foreign id in a response is
// found by one string match. Their listening is a pure function of the (server's) clock, so the
// stand-in and the checks agree on what each person played without sharing state.

// C is the friend check 9 sees revoked and deleted on day 4; D asks and is approved but never
// connects, so its invite expires on day 14.
export const TAGS = ["ADMIN", "FRIENDA", "FRIENDB", "FRIENDC", "FRIENDD"];
const PLAY_S = 200;
// Minutes past 00:00 UTC each person listens, every day.
const WINDOWS = {
  ADMIN: [[13 * 60, 16 * 60]],
  FRIENDA: [[7 * 60, 9 * 60], [17 * 60, 19 * 60]],
  FRIENDB: [[11 * 60, 13 * 60], [19 * 60 + 30, 21 * 60 + 30]],
  FRIENDC: [[9 * 60, 10 * 60]],
  FRIENDD: [],
};

const pad = (n) => String(n).padStart(3, "0");

export function persona(tag) {
  const tracks = Array.from({ length: 30 }, (_, i) => ({
    id: `${tag}xt${pad(i + 1)}`,
    name: `${tag}-only-song-${i + 1}`,
    artist: `${tag}-only-artist-${(i % 5) + 1}`,
    album: `${tag}-only-album-${(i % 6) + 1}`,
    duration_ms: PLAY_S * 1000,
  }));
  const playlists = [0, 1, 2].map((k) => ({
    id: `${tag}xpl${k + 1}`,
    name: `${tag}-only-playlist-${k + 1}`,
    tracks: tracks.filter((_, i) => i % 3 === k || i < 2),
  }));
  return {
    tag,
    spotifyId: `${tag}xspotify`,
    accountId: `${tag}xaccount`,
    displayName: `${tag}-only-name`,
    email: `${tag.toLowerCase()}-only@rehearsal.invalid`,
    tracks,
    playlists,
    liked: tracks.filter((_, i) => i % 2 === 0).slice(0, 12),
    windows: WINDOWS[tag],
  };
}

export const PEOPLE = Object.fromEntries(TAGS.map((t) => [t, persona(t)]));

/** The tag in a bearer, refresh token, code or id: at-FRIENDA-3 → FRIENDA. */
export function tagOf(s) {
  const m = String(s ?? "").match(/(ADMIN|FRIEND[ABCD])/);
  return m ? m[1] : null;
}

/** Every play of `p` that has finished by `nowMs`, newest first, at most `limit`. A play's
 *  played_at is when it ended (the convention skip-rule.ts checks). Day d's plays cycle through
 *  the catalog from offset 7d, so days differ. */
export function playsBefore(p, nowMs, limit = 50) {
  const out = [];
  const day0 = Math.floor(nowMs / 86_400_000);
  for (let d = day0; d > day0 - 30 && out.length < limit; d--) {
    for (const [a, b] of [...p.windows].reverse()) {
      const start = d * 86_400_000 + a * 60_000;
      const n = Math.floor(((b - a) * 60) / PLAY_S);
      for (let k = n - 1; k >= 0 && out.length < limit; k--) {
        const end = start + (k + 1) * PLAY_S * 1000;
        if (end > nowMs) continue;
        const idx = (k + 7 * d) % p.tracks.length;
        const pl = p.playlists[k % p.playlists.length];
        out.push({ track: p.tracks[idx], playedAt: end, context: pl });
      }
    }
  }
  return out;
}

/** What `p` is playing at `nowMs`: the play whose span holds it, or null. */
export function playingAt(p, nowMs) {
  const d = Math.floor(nowMs / 86_400_000);
  for (const [a, b] of p.windows) {
    const start = d * 86_400_000 + a * 60_000;
    const n = Math.floor(((b - a) * 60) / PLAY_S);
    const k = Math.floor((nowMs - start) / (PLAY_S * 1000));
    if (k >= 0 && k < n) {
      return { track: p.tracks[(k + 7 * d) % p.tracks.length], progressMs: nowMs - start - k * PLAY_S * 1000, context: p.playlists[k % p.playlists.length] };
    }
  }
  return null;
}

/** A regex for everything that belongs to anyone but `tag` (ids, names, tokens, e-mail), plus
 *  the extra exact strings given (their uids). */
export function foreignPattern(tag, extra = []) {
  const others = TAGS.filter((t) => t !== tag);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp([...others.map((t) => `${t}(x[A-Za-z0-9]*|-only[-A-Za-z0-9.@]*|-\\d[A-Za-z0-9-]*)`), ...extra.filter(Boolean).map(esc)].join("|"), "i");
}
