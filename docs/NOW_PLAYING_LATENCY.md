# Now-playing latency: from a track change to the new row on Home

Rem, 2026-10-14: when a song finishes and the next one starts, the finished song lands in
today's list about three seconds later; get that to very little without tripping Spotify's
limits. Lane 2290, 2026-10-15.

**Result.** A song that runs out now shows within ~0.7 s of the change (modeled at a 300 ms
round trip) when Spotify reports the change promptly, and within the lag plus ~0.5 s when it
does not; before, the same model gave 1.4 s at best and up to 7.5 s. Spotify calls do not rise:
the schedule makes slightly fewer requests while playing and far fewer while paused or idle.
A **manual skip** made in the Spotify app still waits on the 6 s cadence (0–6 s, mean ~3 s, plus
the round trip); getting that to ~1 s costs a 6× rate, priced in §5 and not built.

## 1. The chain, step by step

A song ends on Rem's phone or desktop at time B. The new row appears when a reply from
`/api/now-playing` showing a different song (or nothing) reaches the browser: the provider's
`setPlaying` re-renders Home, whose handoff effect (`den-home.tsx`, guards in `lib/handoff.ts`)
adds the finished song to today's list in the same render. Everything after that only confirms it.

| step | what happens | delay before | delay after |
|---|---|---|---|
| 1. Spotify's API learns of the change | the device reports the new song; `currently-playing` keeps answering the old one (pinned at its end) until it does | L, unmeasured (modeled 0, 0.5, 1.5 s) | same |
| 2. the poll is sent | **before:** one poll at the predicted end + 1,000 ms; if it (or any steady poll) sampled inside L and saw the old song with nothing left, nothing re-armed it and the next 6 s tick had to catch the change. **after:** a poll at the predicted end + 300 ms; if Spotify still shows the old song with ≤ 1.5 s left, re-ask 700 ms after each reply, up to 6 times | 1.0 s, or up to 6 s more | 0.3 s, then ≤ 0.7 s + one round trip per retry |
| 3. the round trip | browser → Vercel iad1 → `auth()` → the token read from the store (Funnel, ~47–71 ms from Vercel, BRIDGE.md) → `/me/player/currently-playing` (→ `/me/player` on a 204) → the context name (one store read) → reply | modeled 300 ms; realistic 300–600 ms, more during a Zenbook stall | same |
| 4. the row | `setPlaying` → Home's effect → `finish()` → `setTracks` | one render | same |
| 5. later | `doRefresh(true)` at once and 4 s later (recently-played, which lags the player) reconciles the provisional row with the store's; the Zenbook's 2-min `/api/cron/sync` tick and the daily Vercel cron record the play server-side | does not move the row's arrival | same |

The predicted end is anchored at the reply's arrival (`receivedAt + duration − progress`), which is
already later than the moment Spotify measured the progress, so the end poll errs late, never early.

## 2. Measurements, and how they were taken

No production measurement was possible from this lane: it may not use Rem's browser, Spotify
account or production data. Two kinds of evidence instead.

**The schedule, simulated with the real code.** `tests/now-playing-poll.test.ts` ("track change →
seen") drives the new `PollLoop` and a line-for-line model of the old provider schedule (a 6 s
`setInterval` plus the one end poll, overlapping requests allowed, newest applied) against a
scripted player: track "a" ends at 60 s, Spotify samples the player 200 ms after a request leaves,
the reply lands 300 ms after it leaves, and the page opened at each of 60 phases (every 100 ms) of
the 6 s cadence. Latency is B → the first reply showing the next song. Re-run with
`npx vitest run tests/now-playing-poll.test.ts --silent=false`.

| Spotify lag L | before p50 / p95 / max | after p50 / p95 / max | polls per 80 s, before → after |
|---|---|---|---|
| 0 | 1.4 / 1.5 / 1.7 s | 0.7 / 0.7 / 0.7 s | 14.0 → 13.5 |
| 0.5 s | 1.4 / 6.3 / 6.5 s | 0.7 / 0.9 / 1.1 s | 14.0 → 13.6 |
| 1.5 s | 4.6 / 7.3 / 7.5 s | 1.7 / 2.0 / 2.2 s | 14.0 → 13.6 |

A real round trip longer than 300 ms adds the difference to both columns. Rem's ~3 s fits a lag of
roughly half a second to a second and a half on top of a longer round trip; the before column's
p95 jump at L = 0.5 s is the old bug (a poll that sampled inside the lag cancelled the end poll).

**From now on, in production.** Every handoff verdict Home already beacons to `client_metrics`
(`event = 'handoff'`) now carries `value` = ms from the predicted end of the finished song to the
moment its row was judged, and `end=…s` in `meta`. For a song that ran out that is the whole chain
above; a skip reads negative. After a deploy:

```sql
SELECT ts, value, meta FROM client_metrics
WHERE event = 'handoff' AND meta LIKE '%commit|%' AND value >= 0 ORDER BY ts DESC LIMIT 50;
```

## 3. Spotify's limits as they apply here, and the call budget

From docs/multi-user/01f-platform.md §1.4, 01c-sync.md §2.5–2.7 and PLAN.md §7.1 (measured from
`api_log` by the planning lanes):

- **The 30-second window** is per app and unpublished. The busiest windows on record held 56 and 54
  calls with no 429. The only 429s ever logged were recently-played's and `/me`'s daily quota bans
  (Aug 11–17), not this window.
- **The player bucket** (`/me/player`, `/me/player/currently-playing`) has never returned a 429. The
  busiest day was 1,336 calls (Oct 13); the 2-min cron's player check is most of it (1,035–1,303 a day).
- **Rem's now-playing traffic** is 0–96 calls a day: he rarely keeps a tab visible.
- **Vercel Hobby**: 1,000,000 invocations and 4 Active-CPU-hours a month for the whole team; going
  over stops every project for up to 30 days. `lazy-boy` uses ~2.7% of the invocations; its CPU is
  estimated, not read (01f §2.3).
- **Client 429 handling before this change:** none. `/api/now-playing` answered every failure 503 and
  the poll kept its 6 s cadence. Now the route answers a Spotify 429 as 429 with `Retry-After` (the
  instance's cooldown, `spotifyCooldownMs()`), and the poller waits that long (capped at 5 min); other
  errors back off 12, 24, 48, 60 s.

Budget per browser (one leader tab), by state:

| state | before | after |
|---|---|---|
| playing, a tab visible | 10 polls/min + 1 per track | 10 polls/min; at each boundary the end poll replaces the steady one, plus 0–6 burst polls only while Spotify lags (simulated: no rise, 13.5–13.6 vs 14 per 80 s) |
| worst 30 s window, playing | 6 | 12 (5 steady, the end poll and a full 6-poll burst), each 1–2 Spotify calls: ≤ 24, under the 56 seen |
| paused, visible | 10/min | 4/min |
| idle (no device), visible | 10/min, 2 Spotify calls each (both endpoints 204) | 4/min |
| all tabs hidden | end-of-track only (~1 per track) | the same, plus the burst at a boundary |
| two or more tabs | one leader, but a hidden leader kept the lock: a visible tab saw changes only through a ~24–36 s rescue poll | a visible tab takes the lock (Web Locks `steal`), so the visible tab is always the one on the fast schedule; a starved visible follower takes the lead instead of polling beside it |
| requests in flight | interval, end timer, focus and refresh could overlap | one per leader; a refresh during a request asks once more right after it |

The burst is capped (6 × ~1 s) and happens at most once per track, so it cannot become a sustained rate.

## 4. What was built

- `src/lib/now-playing-poll.ts`: `planNextPoll` (the schedule as a pure function), `PollLoop` (one
  timer, one request in flight, `kick`/`wake`, seeded hand-over so a new leader continues the old
  one's schedule) and `leaderElection` (Web Locks with steal on visibility).
- `src/components/now-playing-context.tsx`: the leader runs the loop; `pollOnce` returns the outcome
  the loop plans from; the visibility/focus handler wakes the loop or claims the lead; the follower
  rescue claims the lead.
- `src/app/api/now-playing/route.ts`: a Spotify 429 answers 429 + `Retry-After`.
- `src/app/(app)/home/den-home.tsx`: the handoff beacon's latency value.
- Tests: `tests/now-playing-poll.test.ts` (known answers: a track ending at t polls at t + 300 ms;
  the burst; paused polls every 15 s; a 429 waits Retry-After; one request in flight; two tabs make
  one request per tick; a tab brought forward takes the lead; the latency table) and a 429 case in
  `tests/now-playing-route.test.ts`.

## 5. Manual skips: the options, priced

A skip made in the Spotify app is not predictable, so only the steady rate bounds it. The handoff
also credits only songs heard past 35% (`lib/skip-rule.ts`), so an early skip never makes a row at
any rate; this matters only for late skips. Per visible hour of playback, one browser:

| steady rate | skip seen within (mean) | polls / visible hour | 30 s window | what it risks |
|---|---|---|---|---|
| **6 s (kept)** | 0–6 s (~3 s) + round trip | ~600 | 5 | nothing new |
| 3 s | 0–3 s (~1.5 s) + round trip | ~1,200 | 10 | a 3-hour session = 3,600 player calls, 2.7× the busiest day the bucket has seen; ~2× the Vercel invocations and CPU of a visible tab |
| 1 s | ~0.5 s + round trip | ~3,600 | 30 (+ cron, library scans) | ~10,800 player calls in 3 hours, 8× the busiest day, against an unmeasured daily limit whose breach is a multi-hour ban that would also blind the cron's player probe and with it the harvest gate; ~108k invocations a month at 1 h/day; Spotify's terms list "excessive service calls" as improper use |

Skips made inside Lazy Boy (the chip, a row's play button) already re-poll at once (`refresh()`).
The Web Playback SDK would push events, but only for playback in the browser itself, not the phone
or desktop app. Recommendation: keep 6 s. If manual-skip latency matters more than the risk, 3 s is
the step to try, watched against `/usage`'s per-source Spotify counts for a week.

## 6. What the nearby plans must keep

**Store migration (docs/STORE_MIGRATION.md, lanes 1901–1911).** Each poll does two indexed store
reads (the token row in `meta`, the context name in `contexts`) and one fire-and-forget `api_log`
write per Spotify call. On Turso that is ~2 rows read a poll, ≤ ~1,200 an hour of visible playback,
negligible against R4. Keep: the token and context reads on the user path stay single indexed
reads; `api_log` stays never-awaited (it moves to the Zenbook telemetry store, which may stall); the
route keeps answering a Spotify 429 as 429 with `Retry-After` and any other failure as non-200 (a
200 `{playing:null}` on an error makes Home finish the song mid-play).

**Multi-user (docs/multi-user/PLAN.md §6.6, §7.6, Phase 4a).**
- The 15 s mid-track cadence is `STEADY_MS`. Keep the end-of-track poll and its burst (01c §5.5 already
  says so): they are what make a change show fast, and they cost ~0–6 calls a track.
- The planned ~5 s per-user server memo on `/api/now-playing` must not outlive the song it memoizes:
  expire it at `min(5 s, duration − progress)` of the memoized answer, or the boundary poll and every
  burst retry are answered with the old song from memory and the change shows ~5 s late again.
- A per-user rate bound on `/api/now-playing`, if one is added, must admit a burst: 7 requests in ~6 s
  once a track (the end poll + 6 retries).
- The uid-prefixed lock and channel names (PLAN M7) go through `leaderElection`'s `name` argument; the
  steal-on-visible behaviour holds per name.
- `tests/handoff.test.ts` re-runs at the 15 s cadence (PLAN §7.6); `tests/now-playing-poll.test.ts`'s
  known answers that name 6 s should be re-derived from `STEADY_MS`, not edited by hand.

## 7. Known gaps

- Spotify's own lag (step 1) is not measured; the production beacon above will show it.
- A browser that throttles a hidden leader's timers (Chrome aligns them to 1 s, and after 5 min
  hidden can delay chained ones to once a minute) delays the hidden-only case. A visible tab never
  depends on a hidden one now.
- With two visible tabs during a 429 back-off, the second tab's rescue can take the lead and ask
  once per ~36 s; the server's cooldown answers it without calling Spotify on the same instance.
