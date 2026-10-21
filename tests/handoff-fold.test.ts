// Home's handoff as polls see it (code review 0156, M3): the fold den-home runs on every answer
// (handoff.ts foldHandoff), driven by poll sequences, then judged. The one-verdict cases in
// handoff.test.ts hand judgeHandoff the store's own instants; these make Home derive them, from
// receipts and progress, which is where a wrong verdict comes from.
import { describe, expect, it } from "vitest";
import { foldHandoff, judgeFinished, type HandoffAnswer, type HandoffTrack } from "@/lib/handoff";

const S = 1_000;
const song = (id: string, progressMs: number, durationMs = 200 * S, isPlaying = true): HandoffAnswer => ({
  track: { id, title: id, artist: "x", albumImage: null },
  isPlaying,
  progressMs,
  durationMs,
  context: null,
});

type Poll = [at: number, answer: HandoffAnswer];
/** Run the fold over polls; each finished song → { id, verdict, ran (s, rounded) }. */
function replay(polls: Poll[]) {
  let current: HandoffTrack | null = null;
  let lastChangeAt: number | null = null;
  const out: { id: string; verdict: string; ran: number | null }[] = [];
  for (const [at, answer] of polls) {
    const f = foldHandoff(current, answer, at, lastChangeAt);
    current = f.current;
    lastChangeAt = f.lastChangeAt;
    if (f.finished) {
      const { p, endedAt } = f.finished;
      const ran = p.startAt === null ? null : Math.round(Math.min(endedAt - p.startAt, p.durationMs > 0 ? p.durationMs : Infinity) / S);
      out.push({ id: p.id, verdict: judgeFinished(f.finished, at, true), ran });
    }
  }
  return out;
}
/** Polls every `step` from `from` to `to` (inclusive) of one song started at `startAt`. */
function playing(id: string, startAt: number, from: number, to: number, step = 6 * S, durationMs = 200 * S): Poll[] {
  const polls: Poll[] = [];
  for (let t = from; t <= to; t += step) polls.push([t, song(id, t - startAt, durationMs)]);
  return polls;
}

const T = 1_000_000_000;

describe("foldHandoff on poll sequences", () => {
  it("a song that runs out is current for its length and commits", () => {
    const polls = [...playing("A", T, T, T + 198 * S), [T + 202 * S, song("B", 2 * S)] as Poll];
    expect(replay(polls)).toEqual([{ id: "A", verdict: "commit", ran: 200 }]);
  });

  it("Faint as polls: skipped to, seeked near its end, gone 23 s after it started → a skip", () => {
    // Faint (162.1 s) was current 06:39:44.158 → 06:40:07.550Z and the store ruled it a skip;
    // Home saw it at 99% because of the seek and listed it.
    const D = 162_106;
    const polls: Poll[] = [
      ...playing("prev", T - 100 * S, T - 12 * S, T - 6 * S),
      [T + 3 * S, song("Faint", 3 * S, D)], // the first look, 3 s in
      [T + 9 * S, song("Faint", 150 * S, D)], // seeked to 144 s in between
      [T + 15 * S, song("Faint", 156 * S, D)],
      [T + 24 * S, song("next", 600)], // Faint stopped at T + 23.4 s
    ];
    const faint = replay(polls).find((r) => r.id === "Faint");
    expect(faint).toEqual({ id: "Faint", verdict: "skip", ran: 23 });
  });

  it("a song first seen paused is never credited, however far along", () => {
    const polls: Poll[] = [
      [T, song("A", 150 * S, 200 * S, false)],
      [T + 6 * S, song("A", 150 * S, 200 * S, false)],
      [T + 12 * S, song("B", 1 * S)],
    ];
    expect(replay(polls)).toEqual([{ id: "A", verdict: "never-played", ran: null }]);
  });

  it("repeat-one: the same song back under 3 s at its predicted end is a new play", () => {
    const polls: Poll[] = [...playing("A", T, T, T + 198 * S), [T + 200.5 * S, song("A", 500)]];
    expect(replay(polls)).toEqual([{ id: "A", verdict: "commit", ran: 200 }]);
  });

  it("a jump back to 0 mid-song is a seek, not a new play", () => {
    const polls: Poll[] = [...playing("A", T, T, T + 96 * S), [T + 100 * S, song("A", 1 * S)]];
    expect(replay(polls)).toEqual([]);
  });

  it("a private-session song mints nothing", () => {
    const polls: Poll[] = [
      ...playing("A", T, T, T + 198 * S).map(([at, a]): Poll => [at, { ...a!, privateSession: true }]),
      [T + 201 * S, song("B", 1 * S)],
    ];
    expect(replay(polls)).toEqual([{ id: "A", verdict: "private", ran: 200 }]);
  });

  it("H1: a seek before Home's first look at a song does not move the previous song's run onto it", () => {
    // A (200 s) seen at 120 s; the user skips to B and drags B to 190 s within the next 6 s;
    // the next poll sees B at 196 s, and B runs out 4 s later. The store: A ran 120 s (listen),
    // B about 10 s (skip). A was still current when this tab last saw it, at T + 120 s.
    const polls: Poll[] = [
      ...playing("A", T, T + 6 * S, T + 120 * S),
      [T + 126 * S, song("B", 196 * S)],
      [T + 132 * S, song("C", 2 * S)],
    ];
    const verdicts = replay(polls);
    expect(verdicts[0]).toEqual({ id: "A", verdict: "commit", ran: 120 });
    expect(verdicts[1].id).toBe("B");
    expect(verdicts[1].verdict).toBe("skip");
    expect(verdicts[1].ran).toBeLessThanOrEqual(10);
  });

  it("H1: a paused observation still bounds the change (the song was current when seen paused)", () => {
    const polls: Poll[] = [
      ...playing("A", T, T, T + 90 * S),
      [T + 96 * S, song("A", 95 * S, 200 * S, false)],
      [T + 102 * S, song("A", 95 * S, 200 * S, false)],
      [T + 108 * S, song("B", 100 * S)], // resumed, skipped to B and seeked, all inside 6 s
    ];
    const verdicts = replay(polls);
    expect(verdicts[0]).toEqual({ id: "A", verdict: "commit", ran: 102 });
  });

  it("M1: an in-app play shown with no duration takes the real one from the first answer", () => {
    // Resume shows the song with duration 0, the poll then reports 240 s; skipped at 35 s
    // (15%): a skip in the store, and in Home, which used the 30 s unknown-duration floor.
    const polls: Poll[] = [
      [T, song("B", 0, 0)],
      ...playing("B", T, T + 2 * S, T + 32 * S, 6 * S, 240 * S),
      [T + 36 * S, song("C", 1 * S)],
    ];
    expect(replay(polls)).toEqual([{ id: "B", verdict: "skip", ran: 35 }]);
  });

  it("M1: paused 20 minutes after an in-app play, the run is capped at the song", () => {
    const polls: Poll[] = [[T, song("B", 0, 0)], ...playing("B", T, T + 2 * S, T + 92 * S, 6 * S, 240 * S)];
    for (let t = T + 98 * S; t <= T + 20 * 60 * S; t += 6 * S) polls.push([t, song("B", 92 * S, 240 * S, false)]);
    polls.push([T + 20 * 60 * S + 3 * S, song("C", 1 * S)]);
    expect(replay(polls)[0].ran).toBe(240);
  });

  it("nothing playing ends the song at the receipt", () => {
    const polls: Poll[] = [...playing("A", T, T, T + 120 * S), [T + 126 * S, null]];
    expect(replay(polls)).toEqual([{ id: "A", verdict: "commit", ran: 126 }]);
  });
});
