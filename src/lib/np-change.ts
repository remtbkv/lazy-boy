// The np-change beacon (docs/NOW_PLAYING_2S.md §4.1, lane L1): for every song change a visible
// tab renders, an upper bound on change → render, so today's latency (skips above all) is a
// measurement instead of a model. Pure; now-playing-context.tsx files it, scripts/np-latency.mjs
// reads it.
//
// Clocks: the change happened p_new ms before Spotify sampled (the new song's own progress, a
// duration on Spotify's side), and the sample lies inside the request, so
//   latency ≤ p_new + (reply received − request sent) + (render − received),
// every term on the browser's clock. Nothing subtracts a stamp from another machine's clock;
// `ts_delta` (the change estimate minus Spotify's playback-state `timestamp`) is a cross-check.

type Answer = { track: { id: string }; isPlaying: boolean; progressMs: number; durationMs: number; timestamp?: number };

export type NpChangeKind = "natural" | "skip" | "in-app" | "start" | "return";

export type NpChange = {
  /** The bound, ms. */
  value: number;
  kind: NpChangeKind;
  pNew: number;
  rtt: number;
  render: number;
  /** How long after the change the last answer still showing the old song landed (0 = none):
   *  Spotify's lag, not ours. */
  lagHint: number;
  tsDelta?: number;
};

/** A change ends this close to the old song's predicted end (or past it) → it ran out. */
const NATURAL_SLACK_MS = 2_000;
/** A change this soon after an in-app play is that play landing. */
const IN_APP_MS = 5_000;
/** The tab went hidden at or after `since`: it did not watch the change happen (a tab coming
 *  back finds the change minutes late; requestAnimationFrame waits while hidden), so the bound
 *  measures the time away and the row is filed as kind=return, reported apart (review 0156 M5). */
const away = (hiddenAt: number | null | undefined, since: number) => hiddenAt != null && hiddenAt >= since;

export function npChange(i: {
  /** What the bar showed before this answer, and when that was received. */
  shown: Answer | null;
  shownAt: number;
  next: Answer;
  sentAt: number;
  receivedAt: number;
  renderedAt: number;
  /** When the last in-app play (double-click, menu Play, Resume) went out, or null. */
  inAppAt: number | null;
  /** When the tab last went hidden, or null. */
  hiddenAt?: number | null;
}): NpChange | null {
  const { shown, next } = i;
  if (shown && shown.track.id === next.track.id) return null;
  const pNew = Math.max(0, Math.round(next.progressMs));
  const rtt = Math.max(0, Math.round(i.receivedAt - i.sentAt));
  const render = Math.max(0, Math.round(i.renderedAt - i.receivedAt));
  const changeAt = i.receivedAt - pNew;
  let kind: NpChangeKind;
  if (away(i.hiddenAt, i.shownAt)) kind = "return";
  else if (!shown || !shown.isPlaying) kind = "start";
  else if (i.inAppAt !== null && i.receivedAt - i.inAppAt < IN_APP_MS) kind = "in-app";
  else {
    const leftAtChange = shown.durationMs - (shown.progressMs + (changeAt - i.shownAt));
    kind = shown.durationMs > 0 && leftAtChange <= NATURAL_SLACK_MS ? "natural" : "skip";
  }
  return {
    value: pNew + rtt + render,
    kind,
    pNew,
    rtt,
    render,
    lagHint: shown ? Math.max(0, Math.round(i.shownAt - changeAt)) : 0,
    ...(typeof next.timestamp === "number" ? { tsDelta: Math.round(changeAt - next.timestamp) } : {}),
  };
}

/** The in-app path's bound: click → render, the action's round trip included. `shownAt` is when
 *  the provider applied the song. */
export function npInApp(i: { startedAt: number; shownAt: number; renderedAt: number; hiddenAt?: number | null }): NpChange {
  return {
    value: i.renderedAt - i.startedAt,
    kind: away(i.hiddenAt, i.startedAt) ? "return" : "in-app",
    pNew: 0,
    rtt: i.shownAt - i.startedAt,
    render: i.renderedAt - i.shownAt,
    lagHint: 0,
  };
}

/** The beacon's meta: `path` (poll | in-app; the watcher's stream later), the bound's terms and
 *  a per-tab sequence number, so a lost batch shows as a gap (REVIEW H4.3). */
export function npChangeMeta(c: NpChange, path: string, seq: number): string {
  return `path=${path}|kind=${c.kind}|p_new=${c.pNew}|rtt=${c.rtt}|render=${c.render}|lag=${c.lagHint}|ts_delta=${c.tsDelta ?? ""}|seq=${seq}`;
}

/** An in-app play (context-menu Play, Play from a playlist, dock Resume): run the action, and
 *  only when it succeeds show the song on the bar, stamped with when the action went out so the
 *  beacon can time click → render. A failure leaves the bar alone. */
export async function playThenShow<R extends { ok: boolean }>(
  action: () => Promise<R>,
  show: (startedAt: number, result: R) => void,
  now: () => number = Date.now,
): Promise<R> {
  const startedAt = now();
  const r = await action();
  if (r.ok) show(startedAt, r);
  return r;
}
