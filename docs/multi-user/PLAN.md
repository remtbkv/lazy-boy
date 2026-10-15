# Multi-user lazyboy: the plan

Lane 0223_lb_mu_synthesis of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. It synthesizes the six overviews
(`01a-data.md` to `01f-platform.md`, cited as 01a §n and so on) and the three designs (`design-a.md`,
`design-b.md`, `design-c.md`, cited as A §n, B §n, C §n). Code line numbers are against `ac6f7fe`,
which the overviews cite; `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json
next.config.ts package.json` is empty at `7e0c5b1`. Every number is **[measured]** with its source or
**[estimate]** with its arithmetic. §17 lists everything this lane ran.

Status: outline; sections are filled in order and committed one by one.

## 0. Summary

(to fill last)

## 1. Targets

The brief asked for multi-user support that is secure, keeps performance and uptime, scales with the
store's usage, and keeps search fast. The three designs turned that into checkable numbers in
slightly different ways (A §0.1, B §1, C §1); this plan takes the strictest version of each that the
evidence supports and states how it is measured. §14 walks every target step by step with its budget.

"Rem-like" means Rem's measured profile: ~115 real plays a day over 30 days (01a §6), 129 on Oct 14
(01c §2). A **heavy day** is Oct 14's activity as the store meter measured it (716 ticks, 129 landed
plays, 44 all-time recomputes, ~30 rescans, 01c §2.1-2.3), with three unscoped orphan passes (as that
day had) and eight Home visits (an app-heavy user, 01d §4.2's assumption). "A phone" is Chrome with
the CPU throttled 4×, the stand-in 01d §2.3 measured with; no real phone has been measured.

| id | target | today | measured by |
|---|---|---|---|
| **U** | **5 accounts, Rem included**, on the one Spotify app. Past five, each person runs their own copy, which is the one-user case of the same code | 1 (the owner guard, `src/lib/owner.ts:10-14`) | the dashboard's User Management list; `users` rows |
| **I** | No request, cache entry, browser store, background job or script returns, changes or caches another user's data. Every class of mistake that could do it meets one layer that prevents it and one that detects it (a test in `npm test`, or a runtime check that refuses and logs) | not applicable: one global token row, every read unscoped (01b §1) | the isolation suite (§6.4) on every `npm test`; runtime `isolation` events on `/usage`, expected count 0 |
| **I$** | Isolation costs at most one extra store round trip on Home (~15 ms at STORE_MIGRATION R1's target) and microseconds elsewhere | – | §14.6 |
| **S1** | Repeat visit: search usable ≤ 300 ms after Home's first paint, on a phone | no browser copy yet (STORE_MIGRATION phase E) | `lb:index-idb` (R3) |
| **S2** | First visit on a device: search usable ≤ 2 s after first paint, on a phone at 10 Mbit/s, for Rem today and for a typical one-year friend (18,250 plays, 8,000 library songs, 01d §3.3) | real users, mostly August: median 4.0 s, p90 8.7 s between rows painted and search ready [measured, 01d §2.3] | `lb:history-ready`; 01d's throttled-browser harness re-run on the new bodies |
| **S3** | Keystroke to painted rows ≤ 50 ms on a phone, for search sets up to ~30,000 entries (about twice Rem's) | matching 10.5-13.2 ms at 4× for one-letter queries; keystroke-to-paint 43.8 ms median on a desktop dev build [measured, 01d §2.3] | `lb-perf` `paint=` (GOTCHAS "Measuring a search") |
| **F1** | Observed freshness: any Home view shows every play that ended more than 2 minutes before it opened, and every play that ends while it is open | met for Rem through the on-load sync and the browser's provisional plays (01c §5.3) | the on-load harvest's outcome; the handoff beacon |
| **F2** | Stored freshness with the app closed: a finished play is in the store within ~2 minutes (p50 ~1 min). On a quota day the fair-share brake trips (§7.5): within 15 minutes for whoever is above their share, within 30 minutes for everyone once the app's daily budget is spent | ~2 min for Rem (one tick while playing, `src/app/api/cron/sync/route.ts:121-146`) | each harvest records `now − played_at` for the plays it lands; `/usage` shows p50/p95 per user |
| **F3** | Completeness: no play lost while either pinger runs and no quota ban is in force | one pinger, on the Zenbook (01c §1) | the recorder diff for Rem (STORE_MIGRATION §8 step 13); a harvest before 25 track changes pile up |
| **D1** | Store reads ≤ 1.5M rows (Turso's terms) per Rem-like user on a heavy day, so five such users stay inside R4 (≤ 250M of the free plan's 500M a month) | ~4.5-5.6M on a typical day, ~19M on a day with three unscoped orphan passes [estimate from the meter, 01c §2.7-2.8, §5.9] | Turso's per-database usage, recorded by the daily route |
| **D2** | No read on a per-play, per-tick or per-visit path grows with the user's total stored history | the all-time recompute scans every play up to 144 times a day and grows ~12,000 rows a day, every day (01c §5.9) | the §8 table, reviewed per change |
| **D3** | ≤ 5,000 core rows written and ≤ 50 KB of growth per Rem-like user a day (five users ≤ 10% of the free plan's 10M writes a month) | ~3,000 core rows and ~35 KB a day (01c §2.7, 01a §6) | Turso's per-database usage |
| **A1** | No user-visible request depends on the Zenbook | every authenticated page does (01f §3.2) | STORE_MIGRATION R2's fault injection, repeated with two users |
| **A2** | Closed-app capture survives a Zenbook outage of any length | the only frequent pinger is on the Zenbook (01c §1) | stop the Zenbook timer for 10 minutes; plays land from the other pinger |
| **A3** | One user's failure (a revoked grant, removal from the allowlist, a refused database, a hung Spotify call) costs that user's slot and nothing else | one token's failure stops all capture; one user's 403 fails the tick (01c S2) | the cron fan-out test (§6.4); per-user outcomes in every tick's reply |
| **$** | $0 a month until the first friend; ≤ $26 a month at five users | $0 | §15 |

What changed from the brief, and why:

- **25 users became 5.** Spotify's quota-modes page: "Up to 5 authenticated Spotify users can use an
  app that is in development mode", applied to existing apps from Mar 9, 2026; extended quota mode
  "only accepts applications from organizations (not individuals)" with "at least 250k MAUs"; several
  Client IDs break the one-Security-Code rule and share one quota anyway (all quoted in 01f §1.2-1.3,
  fetched Oct 14). The 25 on today's pages is Client IDs per developer. All three designs and four
  overviews reached the same number.
- **Freshness split into F1-F3**, as B §1 did. Under the documented reading of Spotify's quota (one
  pool per developer account, 01c §4), 2-minute closed-app freshness for five heavy listeners costs
  more recently-played calls a day than the budget August's bans measured (01c §5.1). Nobody sees
  stored freshness while the app is closed, so the plan protects F1 and F3 always and lets F2 degrade
  on the days the budget runs low.
- **D1 is set by need, not ambition.** B set 100,000 rows a day; that is reachable (B §10.2) but asks
  for more write-path machinery than five users need. 1.5M is what keeps five heavy users inside R4 on
  the free plan; D2 is the structural rule that keeps D1 true as histories grow.
- **I and I$ are added**, from "keep it all secure" (A §0.1, C T0).

Two numbers the targets rest on are not measured, and the rollout gates on both (§13): whether
Spotify's development-mode quota is one pool or one per user (01c §4, 01f §1.4), and how much of
Vercel Hobby's 4 Active-CPU-hours a month the team already uses (01f §2.3).

## 2. The three designs compared, and what this plan takes from each

(point-by-point comparison with the choice and its reason)

## 3. The plan on one page

(the architecture, the rules it holds itself to, the order of work)

## 4. Data model

(the app database, the user databases, every table and meta key, the user key, schema versions)

## 5. Identity, sessions and per-user tokens encrypted at rest

## 6. Isolation: enforcement in one place, and the tests that prove it

## 7. Sync fan-out inside Spotify's limits

## 8. Store cost: the write path and the read levers

## 9. Search: per-user payloads, caching and the phone budget

## 10. The store, and STORE_MIGRATION (lanes 1901-1911)

## 11. Migrating Rem's data with nothing lost

## 12. Sign-up gating, privacy, deletion and backups

## 13. Rollout in reversible phases

## 14. Each target, step by step, with its budget

## 15. Costs

## 16. Unknowns and risks

## 17. What I ran

## 18. Decisions that are Rem's
