// scripts/np-latency.mjs (NOW_PLAYING_2S.md §4.1, L1): the np-change rows' percentiles by path
// and kind with db.ts's nearest-rank rule, the per-tab sequence gaps (lost beacon batches), and
// Home's verdicts joined to the store's rows (L2's agreement check, REVIEW M7's exclusion).
import { describe, expect, it } from "vitest";
import { joinVerdicts, percentile, seqGaps, summarize } from "../scripts/np-latency.mjs";

// Stored meta carries metrics-client's page-view tag in front (`pv:<id>|`).
const row = (session: string, value: number, meta: string, ts = "2026-10-22T00:00:00Z") => ({ ts, session, event: "np-change", value, meta: `pv:ab12cd34|${meta}` });

describe("np-latency", () => {
  it("nearest-rank percentiles, as db.ts", () => {
    const v = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(v, 0.5)).toBe(500);
    expect(percentile(v, 0.95)).toBe(1000);
    expect(percentile([730], 0.95)).toBe(730);
  });

  it("n, p50, p95 and max by path and kind", () => {
    const rows = [
      row("s1", 730, "path=poll|kind=skip|p_new=400|rtt=300|render=30|lag=0|ts_delta=|seq=1"),
      row("s1", 3_500, "path=poll|kind=skip|p_new=3100|rtt=370|render=30|lag=0|ts_delta=|seq=2"),
      row("s1", 900, "path=poll|kind=natural|p_new=500|rtt=380|render=20|lag=0|ts_delta=|seq=3"),
      row("s1", 650, "path=in-app|kind=in-app|p_new=0|rtt=620|render=30|lag=0|ts_delta=|seq=4"),
    ];
    expect(summarize(rows)).toEqual([
      { path: "in-app", kind: "in-app", n: 1, p50: 650, p95: 650, max: 650 },
      { path: "poll", kind: "natural", n: 1, p50: 900, p95: 900, max: 900 },
      { path: "poll", kind: "skip", n: 2, p50: 730, p95: 3_500, max: 3_500 },
    ]);
  });

  it("a gap in a tab's sequence is a lost batch; a reload restarts the count", () => {
    const at = (n: number) => `2026-10-22T00:00:0${n}Z`;
    const rows = [1, 2, 5, 6]
      .map((n, i) => row("s1", 1, `path=poll|kind=skip|seq=${n}`, at(i)))
      .concat([row("s2", 1, "path=poll|kind=skip|seq=1", at(0))])
      // s1 reloaded (sessionStorage keeps its id, the page's counter starts again), one lost.
      .concat([1, 3].map((n, i) => row("s1", 1, `path=poll|kind=skip|seq=${n}`, at(6 + i))));
    expect(seqGaps(rows)).toEqual({ sessions: 2, missing: 3 });
  });

  it("verdicts: agreement with the store's row, pending reported apart, an unlisted predecessor excluded", () => {
    const at = (iso: string) => Date.parse(iso);
    const h = (v: string, id: string, iso: string, pred: string) => ({
      ts: iso,
      event: "handoff",
      value: null,
      meta: `pv:ab12cd34|${v}|id=${id}|run=23.4s|at=${at(iso)}|pred=${pred}|gap=1s|prog=99%|end=?|X — Y|from=`,
    });
    const handoffs = [
      h("skip", "faint", "2026-10-21T06:40:07.900Z", "prev1"), // store: skipped → agree
      h("commit", "song2", "2026-10-21T06:44:00.300Z", "faint"), // store: skipped → disagree
      h("pending", "song3", "2026-10-21T06:47:00.000Z", "song2"), // store: listened → pending, listen
      h("commit", "song4", "2026-10-21T06:50:00.000Z", "ghost"), // store's predecessor is song3, not ghost → excluded
      h("commit", "song5", "2026-10-21T06:53:00.000Z", "song4"), // never listed
    ];
    const plays = [
      { played_at: "2026-10-21T06:39:44.158Z", track_id: "prev1", skipped: 0 },
      { played_at: "2026-10-21T06:40:07.550Z", track_id: "faint", skipped: 1 },
      { played_at: "2026-10-21T06:44:00.000Z", track_id: "song2", skipped: 1 },
      { played_at: "2026-10-21T06:47:00.400Z", track_id: "song3", skipped: 0 },
      { played_at: "2026-10-21T06:50:00.200Z", track_id: "song4", skipped: 0 },
    ];
    expect(joinVerdicts(handoffs, plays)).toEqual({
      judged: 5,
      agree: 1,
      disagree: [{ id: "song2", home: "commit", store: "skip" }],
      pending: { listen: 1, skip: 0 },
      excluded: [{ id: "song4", reason: "store's predecessor is song3, Home saw ghost" }],
      unlisted: [{ id: "song5", home: "commit" }],
    });
  });
});
