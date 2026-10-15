# Design B — multi-user lazyboy, performance and scale first

Lane 0222_lb_mu_design_b, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. One of three independent designs; this one starts from performance and scale: search
stays instant and sync stays fresh at 250 users on the cheapest store that holds, with the arithmetic
for every budget. Built on the six overviews (`01a-data.md` to `01f-platform.md`), cited as 01a §n
and so on; code line numbers are against `ac6f7fe` (no file under `src/`, `scripts/`, `ops/` or
`tests/` changed since). Every number is labelled **[measured]** with its source, or **[estimate]**
with the arithmetic.

Status: outline. Sections are filled and committed one at a time.

## 0. Summary

(to be written last)

## 1. Targets, as briefed and as refined

Each target below gives the brief's wording, what the overviews force it to become, today's value,
and the instrument that checks it. §17 scores the design against each.

**T1 — Users.** Briefed: 25 under Spotify's development mode, with the path to more. Refined: **five
accounts on the one Spotify app, Rem included.** Spotify's quota-modes page says "Up to 5
authenticated Spotify users can use an app that is in development mode" (quoted in 01f §1.2, 01c §4,
01e §5.4); extended quota mode takes only organizations with "at least 250k MAUs" (01f §1.3); and
spreading users over several Client IDs breaks the Developer Terms' one-Security-Code rule and buys no
quota, because development-mode quota is "counted per developer account" (01f §1.3, 01c §4). So 25 and
250 cannot be served from this app. The brief for this design still asks for 250, and I keep it as
the sizing point for everything Spotify does not control (store, Vercel, the scheduler, the payloads):
if the cap ever lifts (a grandfathered list on the dashboard, a policy change), Spotify should be the
only thing that binds. §10 carries every budget at 5, 25 and 250. The path past five on today's
policy is each person running their own copy (01f §5.2, option E); the per-user work in this design
speeds those copies up too, since a one-user copy runs the same code. Today: one account (the owner
guard, `src/lib/owner.ts:10-14`). Checked by: the dashboard's User Management list, which also says
whether the owner counts toward the five (01f §1.2, unverified).

**T2 — Search.** Briefed: first payload under 2 s on a phone, keystroke filtering under 50 ms.
Refined, using 01d's definitions (01d §2.3, §5.2, decision 3):

- *A phone* is Chrome on the Mac with the CPU throttled 4× (Lighthouse's stand-in for a mid-tier
  Android, the setting 01d measured at) on a 10 Mbit/s connection. Slow 4G (1.6 Mbit/s) is a stated
  miss for first visits above a light user (§17), not a target, unless Rem decides otherwise.
- *First payload* is Home's first paint to search usable over the user's whole library and history
  (`lb:history-ready`), on a first visit with an empty browser cache: **≤ 2 s**. A repeat visit:
  **≤ 300 ms** (STORE_MIGRATION R3).
- *Keystroke* is keystroke to results painted: **≤ 50 ms at 4×** for search sets up to ~30,000
  entries, about twice Rem's today. Past that size the design names the lever (§9) rather than
  promising the number.

Today [measured, 01d §2.3]: real users waited a median 4.0 s (p90 8.7 s) between the page's rows and
search being ready (130 of 135 hard loads from August); the client spends 264 ms at 4× parsing and
building, 199 ms of it materializing every day of history; matching a one-letter query is 10.5 ms at
4×, and the app's own keystroke-to-paint was 43.8 ms median on a desktop (dev build, 2026-08-05).
Checked by: `lb-perf` and the client metrics' `history-ready` mark, plus 01d §2.3's throttled-browser
harness re-run on the new bodies.

**T3 — Freshness.** Briefed: history within about 2 minutes for an active user. Refined into two
numbers, because the quota cannot buy the second one for five heavy listeners:

- *Observed freshness*: any Home view, on any device, shows every play that ended more than 2
  minutes before the view opened, and every play that ends while it is open. **Target: always.**
- *Stored freshness*: with the app closed, how long until a finished play is in the store. **Target:
  ≤ 2 minutes while Spotify's shared budget allows it** (one or two Rem-like users), **≤ 10 minutes at
  five Rem-like users** if the recently-played quota belongs to the developer account, as Spotify's
  docs say (01c §4).
- *Completeness* is a floor, not a target: no play is lost while either pinger runs, because every
  user is harvested before 25 tracks pile up, half of recently-played's 50 (GOTCHAS "`recently-played`
  only returns the last 50 plays").

Why split: 2-minute stored freshness for five Rem-like users costs ~750-830 recently-played calls a day
(01c §5.1, policy i) against a budget measured at ~725-800 for the whole app in August (01f §1.4), and
nobody sees stored freshness while the app is closed. Today [code]: a play reaches the store within
one 2-minute tick while something plays (`src/app/api/cron/sync/route.ts:121-146`). Checked by: the
harvest records each landed play's lag (`now − played_at`) in the user's sync state (§7), and /usage
shows its p50/p95 per user.

**T4 — Store cost per user per day.** Briefed: the store's reads and growth per user per day, with no
number. Refined, for a user who listens like Rem at today's history (22,040 plays, 01a §6):

- **reads ≤ 100,000 rows a day**, with no term on the request or sync path that grows with the
  user's stored history (only the nightly backup and rare repair events read whole tables);
- **writes ≤ 2,500 rows a day**; **storage growth ≤ 50 KB a day**.

These put five users under 5% of Turso's free plan on every dimension and 250 users on a plan under
$10 a month (§10). Today [measured, the store meter, 01c §2.7]: 4,252,260 rows read on Oct 14, 53% of
it one full `plays` scan repeated 44 times; 13,480 rows written, ~3,000 of them core; core data grows
~35 KB a day (01a §6). Checked by: Turso's per-database usage endpoint, which returns `rows_read`,
`rows_written`, `storage_bytes` and `bytes_synced` for one database over a window
(https://docs.turso.tech/api-reference/databases/usage, fetched 2026-10-14). With a database per user
(§4) that is each user's exact cost, and the daily route records it.

**T5 — Uptime.** Briefed: with the Zenbook's single point of failure addressed. Refined: **no machine
in Rem's apartment sits on any user's request path, and none is the only trigger of closed-app
capture**; a Zenbook outage of any length loses no page and no play; one user's failure (a revoked
token, removal from the allowlist, a Spotify error) costs that user's slot and nothing else. Turso and
Vercel remain single providers, accepted, with the quota block turned into a bill (§12). Today: every
authenticated page and the 2-minute pinger run through the Zenbook (01f §3.2). Checked by:
STORE_MIGRATION's R2 fault injection, repeated with the Zenbook's pinger stopped.

**T6 — Isolation.** Not in the brief's list, but Rem's first words were "keep it all secure": **no
request, cache entry, browser store or background job returns or changes another user's data.**
Checked by: the two-user test suite in §6, which has to fail on purpose before it is trusted.

## 2. The design on one page

(the rule — per-user work proportional to what changed — the architecture, and what it replaces)

## 3. Where one user's cost goes today

(every per-user term with its measured cost and how it grows; which mechanism removes it)

## 4. Data model: how every table and meta key gets a user

(database per user plus an app database; every table and meta key mapped; the user key; schema
versioning in place of `init()`)

## 5. Tokens: per user, encrypted at rest

## 6. Isolation, and the tests that prove it

## 7. Sync: fan-out, freshness and Spotify's budget

## 8. The write path: derived data updated by append

## 9. Search: payloads, caching, and the budget for every step

## 10. The store budget per user per day, and the plan that holds at 5, 25 and 250

## 11. The store choice, and what STORE_MIGRATION needs

## 12. Uptime: the Zenbook and the other single points

## 13. Migrating Rem's data with nothing lost

## 14. Sign-up gating, privacy and account deletion

## 15. Rollout in reversible phases

## 16. Costs

## 17. Scorecard: each target met or missed, and the options where missed

## 18. Decisions that are Rem's

## 19. What I ran, and what I did not measure
