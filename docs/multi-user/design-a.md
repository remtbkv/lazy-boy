# Design A — isolation first: one user can never see or change another's data

Lane 0222_lb_mu_design_a of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. Line numbers are against commit
`774bb21`; `src/`, `scripts/`, `ops/` and `tests/` are identical to `ac6f7fe`, the commit the six
overviews cite (`git diff --stat ac6f7fe HEAD` over those paths is empty). Every claim about the
current system cites `file:line` or an overview section (01a-01f); every number is **[measured]**
with how, or **[estimate]** with the arithmetic. Section 17 lists everything I ran.

Status: outline; sections are filled in order and committed one at a time.

## 0. Targets, and the design on one page

### 0.1 The targets

The brief set five targets. Two of them change after the overviews, and isolation adds one of its
own. Section 13 shows, step by step, how the design meets each one and where it does not.

| id | target | how it is measured | change from the brief, and why |
|---|---|---|---|
| **U** | **5 accounts, Rem included**, on the one Spotify app in development mode. The cap is a setting (the invite limit, §10), not a structural limit: the design holds unchanged to Turso's 100-database free limit and §13.1 says which budget breaks first above five. Past five, each extra person runs their own copy, which in this design is the one-user case of the same code | the dashboard's User Management list; `users` rows | The brief says 25. Spotify's quota-modes page says "Up to 5 authenticated Spotify users can use an app that is in development mode", applied to existing apps from Mar 9, 2026; the 25 on today's pages is Client IDs per developer, not users; extended quota takes only organizations with 250k MAU; several Client IDs break the Developer Terms and share one quota anyway (01f §1.2-1.3, 01c §4, 01e §5.4). A grandfathered list above five is possible and shows only in the dashboard (01f §1.2) |
| **S1** | Repeat visit: search usable within **300 ms** of Home's first paint | `lb:index-idb` mark (STORE_MIGRATION R3) | unchanged in substance; "a phone" = a mid-tier Android, emulated as 4× CPU throttling, the convention 01d §2.3 measured with |
| **S2** | First visit on a device: search usable within **2 s** of first paint for a typical one-year user (18,250 plays, 8,000 library songs, 01d §3.3) on a 10 Mbit/s connection | `lb:history-ready` | the brief's "first payload under 2 s on a phone", with the network stated; slow 4G (1.6 Mbit/s) is a stated miss above a light user (§13.2, 01d §5.2) |
| **S3** | A keystroke paints filtered rows within **50 ms** (p50, 4× CPU) at today's index size and at a heavy one-year user's (15,000 library songs, 36,500 plays) | `lb-perf` `paint=` (GOTCHAS "Measuring a search") at 4× throttling | unchanged; the brief said "filtering", and the paint is what a person waits for |
| **F** | A listening user's play is in the store within **2 minutes** of the track ending, app open or closed, and every play reaches the store before it can scroll out of Spotify's 50-play window | play `played_at` vs. the row's arrival (the harvest's `last_sync` stamp) | unchanged as a target. Under the documented reading of Spotify's quota (one pool per developer account, 01c §4) five heavy listeners cannot all have it with the app closed; §6.3 and §13.3 say what the design does then and what it costs |
| **D** | Store cost per Rem-like user on a heavy day: **≤ 1.5M rows read, ≤ 5,000 core rows written, ~35 KB of growth**, and no per-play or per-tick read that grows with the user's total history | Turso's per-database usage (one database per user makes it per user, §2.1); the daily usage row (STORE_MIGRATION phase A item 7) | the brief asked for the numbers; these are the per-user shares that keep five such users inside STORE_MIGRATION's R4 (≤ 50% of 500M reads, ≤ 10% of 10M writes a month): 250M ÷ 5 ÷ 30 = 1.67M a day |
| **A** | Every user-facing request works with the Zenbook down or frozen (R2 at N users); closed-app capture continues for every user with the Zenbook down; one user's failure (a revoked grant, de-allowlisting, a broken database) touches only that user | R2's fault injection repeated with two users; the per-user outcome list from the cron (§6) | the brief's "Zenbook single point of failure addressed", made checkable |
| **I** | No code path returns, changes or caches one user's data for another, **including through a bug in any single route**: every class of mistake in §1 meets at least one layer that makes it impossible to write and one that catches it (a test or a runtime check that refuses) | the isolation suite in `npm test` (§5); runtime refusals logged as `isolation` events | this lane's angle |
| **I$** | Isolation costs at most **one store round trip on Home** (~15 ms at R1's target) and nothing measurable elsewhere | §2.9 | this lane's angle |

### 0.2 The design on one page

- **One database per user** on Turso, plus a small app database for the user list, the encrypted
  Spotify tokens, invites and the sync queue (§2.1, §3). Rem's database is the `lazyboy` database
  STORE_MIGRATION creates, untouched. A statement sees only the database its client points at, so
  the fifty-odd statements in `db.ts` that would each need a `user_id` filter in a shared store
  (01a §8.1) need none, and none of them can be forgotten.
- **A user id that only the gate can mint.** `UserId` is a branded type; three functions create one
  (the request gate, the cron's claim, admin scripts). Everything per-user hangs off
  `forUser(uid)`. A route that builds an id from its input does not compile (§2.2).
- **A database that names its owner.** Each user database stores `owner_uid`; the handle refuses a
  database that names someone else (§2.3). Every cached per-user value carries its owner and is
  checked on the way out, so a cache-key mistake serves nobody else's data in production, not only
  in tests (§2.4).
- **Tokens that carry their owner**: one AES-256-GCM blob per user with the user id as associated
  data, and a Spotify client that refuses a token whose owner is not the caller (§2.5, §4).
- **The browser** sees an opaque per-user key (an HMAC of the id) in ETags, segment URLs and every
  storage key, and sign-out clears storage (§2.6).
- **Tests**: two simulated users with deliberately colliding data, a faithful `unstable_cache` stub,
  every entry point called as the wrong user, and a byte-for-byte check that user B's database file
  is unchanged by anything user A does (§5).
- **Sync** follows 01c's due queue, plus a per-user share of the scarce recently-played budget so
  one heavy listener cannot get everyone banned (§6). **Search** follows 01d's monthly segments and
  lazy days, keyed per user (§7).
- **Rollout** in six phases, each reversible; the first friend arrives in phase 4, and nothing
  before it changes what anyone but Rem can do (§14). **Cost**: $0-26 a month at five users, all
  of it plan choices that exist without isolation (§15).

## 1. Why isolation first, and the bugs it has to survive

The incident that started this program shows the shape of the risk. The store holds one global
token row and every request, page and cron tick uses it, so a second account's sign-in turned
every request into that account's request, and the cron recorded the second account's plays into
Rem's history (commit `044c9b6`; 01b §1.2). The overviews then found how wide the single-user
assumption runs: 38 places in the data layer (01a §7), 16 actions, 4 routes and a page that call
Spotify with whatever token is stored, seven Data Cache entries and both search ETags with no user
in the key (01b §0), and process state that hands one user's refreshed tokens to another (01e A2).
Several of the failures are silent and permanent: a library sync that deletes everyone else's
playlists (01a D12), skip verdicts and listened time computed from another person's previous play
and then stored (01a D18), a play dropped because another user played the same track in the same
millisecond (01a D17).

So the design starts from the mistakes it must survive rather than from the features. These are
the classes, each traced to where the overviews found an instance:

| # | class of mistake | instance today |
|---|---|---|
| M1 | a store statement that forgets the user | 01a D12-D19: more than fifty statements in `db.ts`, plus five import scripts |
| M2 | a user id taken from request input (path, query, body, a client-chosen key) | none yet; it is the natural bug once ids exist |
| M3 | an entry point that reads before, or without, the gate | `/home` reads in the same `Promise.all` as `auth()` (`src/app/(app)/home/page.tsx:78-83`, 01b E5); `logout` has no gate (01b E3) |
| M4 | a cache key without the user, or with the user captured in a closure Next cannot see | all seven `unstable_cache` entries (`db.ts:983, 1082, 1176, 1181, 1600, 1615, 1906`); Next 16.2.6 keys on the callback's source, the key parts and the arguments only (01b §3.1) |
| M5 | process state shared across users | `inflightRefresh` (`src/lib/auth.ts:188`), `playlistsCache` (`src/lib/spotify/resources.ts:81`), `currentSyncId` (`src/lib/playlists-sync.ts:22`), argument-less React `cache()` boxes (`auth.ts:73`, `db.ts:402`, `db.ts:854`) |
| M6 | the wrong Spotify token for the user | 01b A1-A4, 01e A2 |
| M7 | browser state that outlives a change of user | ETags with no user (`src/app/api/search/library/route.ts:39`, `src/app/api/search/history/route.ts:26`); `lb-days`, `lb-nowplaying`, `clean:active` (01b §3.6) |
| M8 | background work that mixes users | a cron fan-out over today's code: 01c S3, S7, S8 |
| M9 | a wrong mapping from a user to their storage (a provisioning, restore or migration mistake) | new in any multi-user design |
| M10 | the tables that must stay shared (users, tokens, telemetry, the sync queue) and the operator's views of them | `/usage` shows everyone's telemetry (01b B8) |
| M11 | scripts and dev servers writing production data with no user | 01a D33, D38 |
| M12 | binding a sign-in to the wrong account | linking on Spotify's mutable `id` (01e §5.5); an invite claimed twice |
| M13 | one user's usage exhausting a quota every user shares | Turso's org-wide rows-read block, Spotify's per-developer-account quota, Vercel's team allowances (01f §1.4, §2.2, §4.2) |

The rule this design holds itself to: every class meets at least one layer that makes the mistake
impossible to write or harmless when written, and at least one that detects it, either a test in
`npm test` or a runtime check that refuses to serve. Section 2.8 checks the table against the
layers. M13 is different in kind: no code can make a shared quota private, so the design budgets
it per user and keeps one user's spend from becoming everyone's outage (§6.4, §13.4).

## 2. Where enforcement lives

### 2.1 Layer 1: one database per user
### 2.2 Layer 2: a user id only the gate can mint
### 2.3 Layer 3: the store handle, and a database that names its owner
### 2.4 Layer 4: caches, process state and background tasks
### 2.5 Layer 5: Spotify credentials that carry their owner
### 2.6 Layer 6: the browser
### 2.7 The shared remainder: app database, telemetry, operator views, scripts
### 2.8 Every bug class against the layers
### 2.9 What isolation costs

## 3. Data model: how every table and meta key gets a user

## 4. Per-user tokens, encrypted at rest

## 5. Isolation tests

## 6. Sync fan-out within Spotify's limits

## 7. Search: per-user payloads and caching

## 8. The store, and what STORE_MIGRATION should change

## 9. Migrating Rem's data with nothing lost

## 10. Sign-up gating

## 11. Privacy

## 12. Account deletion

## 13. Meeting each target, step by step

## 14. Rollout in reversible phases

## 15. Costs

## 16. Decisions that are Rem's

## 17. What I ran, and what I do not know
