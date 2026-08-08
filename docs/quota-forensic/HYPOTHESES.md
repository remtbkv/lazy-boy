# Hypothesis tree — where did August's rows_read actually go?

Working file (survives context refreshes). Confidence updates as evidence lands; every
entry names the observation that would move it. The mystery, precisely: the counter
recorded +31.0M in Aug 7 1:26 PM → Aug 8 1:06 AM ET while the fixed build's measured
costs — even with an open, visible tab and continuous listening — bound the app at
~0.3M/h ≈ 3.6M for that window; two direct 15s-resolution timelines inside earlier
hot aggregates saw only 0.15–0.4M/h. Roughly 27M of the evening window has no
client-side account.

## H1 — Delayed/batched posting (usage executed earlier, posted late) — conf 0.35 ↑

Server posts usage to the org counter in lumps (per connection close / periodic flush /
aggregation job), so endpoint deltas mix past execution into later intervals.
- For: the 7.3K `count(*)` that never visibly posted within 12 s (Aug 7); timelines see
  small real-time ticks while lumps land unobserved; the 14M post-block overshoot fits
  late posting of pre-block execution.
- Against: the small per-tick increments (+159/+349) DO post in near-real-time — so
  any batching is selective (by connection lifetime? by size?), not global.
- Discriminators: **P2** (write-posting latency, short vs long-lived connection);
  **P1** (any counter movement in a fully-quiet blocked window = lag caught live);
  1-min poller step-size distribution post-unblock.

## H2 — Migration/meter accounting error (server-side miscount) — conf 0.30 ↑↑

The meter itself is wrong this month: instance migrations double-count, re-aggregate,
or corrupt org totals.
- For (all observed, timestamped): bytes_synced DECREASED 2.42→2.28 GB; instance
  3d5671ac frozen at exactly 428,393,023; a THIRD instance (fa59eb0e) appeared
  overnight Aug 8 while the usage endpoint went unresponsive 15+ min; transcribed
  Aug 7 8:51 AM readings suggest per-instance sums exceeded the org total by ~5M
  [UNVERIFIED — re-derive live when the endpoint recovers]; +14M overshoot past a
  hard block.
- Against: nothing yet directly shows rows_read inflation — anomalies could be
  cosmetic/reporting-only while the underlying total is honest.
- Discriminators: **P3** (recovery jump vs 513,980,496 with zero client activity);
  live instance-sum consistency check; researcher's sweep of known Turso issues;
  P1 flat-line or drift.

## H3 — A missed reader (real burn, real rows, not our app's known paths) — conf 0.25

Something real scans the DB outside the modeled paths: an unknown client with the
DB token, an old deployment still receiving traffic, a Turso-side console/inspector
session, the +190/30s metronome's owner at higher gear.
- For: the +190/30s event source was never identified; log tailing only ever covered
  ONE deployment; the midday +5.1M burst stopped exactly at session expiry (a real
  client behavior, not a meter artifact).
- Against: the blocked state should now unmask every reader as a BLOCKED error —
  and the burn's scale (2.7M/h sustained) needs ~7.5K rows/s, a heavy scanner.
- Discriminators: **logtail census during the blocked period** (every reader now
  throws visibly); post-unblock per-route attribution vs counter; whether burn
  resumes instantly at unblock with no app traffic.

## H4 — Real lumpy burn by the app itself via an unmodeled path — conf 0.10 ↓

Some app path (old-build tab via skew protection, broken cache ⇒ rebuild-per-request,
LIKE-fallback search) really did scan millions.
- Against (tonight's arithmetic): the fixed build's worst open-tab case is ~0.3M/h;
  a session-expired tab does no authed DB work; a re-login gets the new build. The
  Vercel Data Cache per-entry size cap could theoretically void the library-payload
  cache (~1.6MB entry) ⇒ rebuild per fetch — but payload fetches are once-per-version,
  not per-request, so even that caps well below the observed rate.
- Discriminators: logtail (would show the requests); midday-burst shape analysis
  (27K/30s cadence match against request logs is retroactively impossible — stays
  unresolved unless H1/H2 explain it).

## Sub-mysteries tracked

- **+190/30s metronome** (Aug 7 1:20–1:26 PM, session expired, plays frozen): no 30s
  cadence exists in the app's client code (checked: now-playing 6s, sync-on-load 120s,
  den-home 120s visible-only). Owner unknown. Logtail census may name it.
- **401 five-minute pinger**: external, stale secret, rejected pre-work (~0 rows).
  Identity findable from logtail user-agent once captured.
- **Aug 7 midday +5.1M** (11:47–1:20, 12 plays, pre-slow-marker build): ~27K/30s
  cadence-shaped; candidates = live-keyed payload rebuilds on some 30s client trigger
  (none found in current code) or fallback LIKE search. Retroactively untestable —
  park unless H1/H2 restates it.

## Verdict rule (pre-committed)

No hypothesis is "the answer" until it survives the mission's bar: a pre-registered
forecast window (H3/H4 family) or a twice-reproduced demonstration (H1/H2 family).
Confidences here prioritize experiments; they are not findings.
