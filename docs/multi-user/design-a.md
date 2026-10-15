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

Six layers, from the store outwards, then the tables that have to stay shared. Each subsection
says what the layer is, where it sits in the code, which classes of §1 it stops, what it does not
stop, and what it costs.

### 2.1 Layer 1: one database per user

**What.** Each user's data lives in a libSQL database of its own on Turso: Rem's is `lazyboy`, the
database STORE_MIGRATION's cutover creates (its §4, §8 step 6), and each friend gets
`lb-u-<12 random base32 characters>` in the same group (`default`, `aws-us-east-1`, next to Vercel's
iad1). Each holds today's seven core tables unchanged (`tracks`, `plays`, `contexts`, `meta`,
`playlists`, `playlist_tracks`, `saved_tracks`; `db.ts:158-243` less the three telemetry tables).
A separate app database, `lazyboy-app`, holds what is shared by nature: the user list, the
encrypted tokens, invites, the sync queue and two global settings (§3.1). Telemetry stays where
STORE_MIGRATION puts it, on the Zenbook (its §4-5).

**What it stops.** M1, by construction. A whole-table statement such as `storePlaylists`' `DELETE
FROM playlists` (`db.ts:1848-1883`), the gap chains of `recomputeSkipFlags` (`db.ts:780-822`), or
`recordPlays`' dedupe read (`db.ts:484-496`) is already correct when the table is one user's. 01a
§8.1 counts what that removes: census items D4-D19, D21, D23 and D25 need no SQL change at all.
It also stops the quiet half of M9's damage: two users can never end up interleaved inside one
table, so a mistake in routing is a wrong-database error, never a corrupted shared table.

**What it does not stop.** Choosing the wrong database (§2.2-2.3), caches (§2.4), process state
(§2.4), tokens (§2.5), the browser (§2.6) and the shared tables (§2.7).

**Why not one shared database with a user column.** It puts every statement under one rule,
"remember the user", and the census shows what a single miss does (D12 deletes other users'
playlists; D18 stores wrong verdicts for good). SQLite and libSQL have no row-level security, so the
rule would live only in application code. A lint that checks every SQL string for `user_id` is
brittle exactly where it matters: the orphan predicate is a correlated subquery inside an `UPDATE`
(`db.ts:700-751`), and a lint has to understand every table reference in it. Postgres with
row-level security would put the rule in the database, but it means leaving libSQL: rewriting
SQLite-specific SQL across `db.ts`'s 3,212 lines (`INSERT OR IGNORE`, `date(played_at, '±N
minutes')`, partial indexes), abandoning the STORE_MIGRATION plan the day after it runs, and taking
on RLS's own failure mode, a pooled connection that runs a query before the user setting is
applied. At five users that trade is not worth making.

**Turso facts this rests on**, read from Turso's pages at 10:11-10:13 PM today (§17):

- The free plan allows 100 databases; paid plans are unlimited; "Idle databases cost only storage"
  (turso.tech/pricing). Rows read and written are counted per organization (01f §4.2), so the
  number of databases does not change the read budget.
- One token can reach every database in a group: `turso group tokens create` makes "a new token
  that can be used to connect to any database in the group"; `turso db tokens create` makes one for
  a single database; both take `--read-only` and `--expiration` (docs.turso.tech, CLI reference).
- Multi-DB Schemas, which would have pushed one schema to many databases, is "now deprecated for
  all new users" (docs.turso.tech/features/multi-db-schemas). Migrations therefore loop over the
  databases (§3.5). At six databases that is a loop, not a system.
- Deletion is cleaner per database. "PITR restores an existing database — it cannot bring back a
  database that was deleted. On paid plans, deleted databases can be restored for up to five days"
  (docs.turso.tech/features/point-in-time-recovery), while rows deleted inside a living database
  stay restorable through point-in-time recovery for 24 hours on Free and "10, 30, or 90 days" on
  Developer, Scaler and Pro. A shared database on Developer would keep a deleted user's rows
  restorable for ten days, past Spotify's five-day deletion term (01f §1.5); destroying a user's own
  database the day they leave stays inside it (§12).
- The platform API reports usage per database (the docs list a per-database "Usage" endpoint), so
  per-user rows read come free with this layout (target D).

**Credentials for the user databases.** The runtime holds one group token (Production only, type
Secret), and the backup job a read-only group token. I considered a token per user database: it
does not narrow anything the runtime can do, because the runtime must reach every user's database
to serve them, and it adds a second user-to-credential mapping that can itself be wrong. Not worth
it at five.

**Cost.** Per request, nothing: one user's reads go to one database, as today. Per cold process,
each user database the process touches pays one check on open (§2.3), which replaces the eight
serial statements `init()` runs today. Operationally, schema changes and backups run once per
database (§3.5, §8).

### 2.2 Layer 2: a user id only the gate can mint

**What.** A branded type in a new `src/lib/identity.ts`:

```ts
declare const brand: unique symbol;
export type UserId = number & { readonly [brand]: "UserId" };
```

A plain number cannot be passed where a `UserId` is expected, so nothing can reach a user's data
with an id it made up. Three functions mint one, and a static test (§5.3) pins the list of files
allowed to import the minting helper:

1. **`gate()`**, behind every page, action and route. It calls `auth()`; the jwt callback has
   already checked, in its one store query, that the session's user exists, is active, has the
   current `session_epoch`, and has a token (§4.2). `gate()` returns `{ uid, hk, admin, spotify }`
   or `null`. Three thin wrappers give each kind of entry point its refusal: `requireUser()`
   redirects a page to `/login`, `requireUserForRoute()` returns a 401, `requireUserForAction()`
   returns `{ ok: false }`. `spotify` says whether the user's Spotify grant is live; reading one's
   own stored history does not need it, calling Spotify does (01b §2.4's recommendation), so
   `getSpotifyFor(user)` refuses when it is false.
2. **`claimDueUsers()`**, the cron's claim on the sync queue (§6.2): the uids it returns are the
   rows it just leased.
3. **`scriptUser(argv)`**, for the import and maintenance scripts: `--user <id>` is required and
   checked against `users` (§2.7).

**What it stops.** M2 at compile time: `forUser(Number(params.id))` is a type error, and `npm run
build` type-checks. M3: a store read needs a `UserId`, so it cannot run before the gate has
returned one, which also ends the anonymous reads on `/home` (01b E5) because an anonymous request
never gets a uid. M12 partly: the uid in the session comes from the users row at sign-in, never from
the incoming token or the profile alone (§10.2).

**What it does not stop.** A cast (`as UserId`), which the static test forbids outside
`identity.ts`; and a correct `UserId` used for the wrong purpose inside the right user's own
request, which is not a cross-user problem.

**Home's parallel wave.** Today Home starts three reads in the same `Promise.all` as `auth()`
(`src/app/(app)/home/page.tsx:78-83`), a deliberate latency choice (01b E5 cites commit `e5dd8bc`).
Under this layer the payload read needs a `UserId`, so Home pays the gate first and the read
second: one extra store round trip, ~15 ms at R1's target. If R1 misses badly after the move, a
safe variant exists: decrypt the uid from the cookie without a store read, start the read, and
release its result only once the gate confirms the same uid. I would hold that in reserve; it is a
second way to reach user data, and 15 ms is under 1% of S2's budget.

### 2.3 Layer 3: the store handle, and a database that names its owner

**What.** `db.ts` stops exporting per-user functions at module level. Its 74 async exports (01a D2)
split three ways:

- **per user**: reached only through `forUser(uid: UserId): UserStore`, an object whose methods are
  today's functions bound to that user's client and passing `uid` into every cache key;
- **app**: a new `src/lib/app-db.ts` holding every statement on the app database (§2.7);
- **telemetry**: the client STORE_MIGRATION phase A creates (`getTelemetryClient()`, its §6 item 1).

`forUser` gets its client from `userClient(uid)`: a per-process `Map<UserId, Promise<Client>>`
filled from `users.db_url`, read once per process per user. On the first open in a process the
client runs one statement on the user's database:

```sql
SELECT key, value FROM meta WHERE key IN ('owner_uid', 'schema_version')
```

and refuses the database, logs an `isolation` event and marks the user `backoff` if `owner_uid` is
not the uid it was opened for, or the schema version is not the one the code expects.
`owner_uid` is written once, when the database is provisioned (§10.1) or migrated (§9), and nothing
in the app writes it again.

**What it stops.** M9: a users row pointing at another user's database, a restore into the wrong
database, a provisioning script run with the wrong argument. Each turns into a refused open and a
logged event, never a request served from someone else's data. M1's residue: there is no
module-level function left that could run against "the" database.

**What it does not stop.** A uid that is itself wrong (Layer 2's job), and anything that never
touches the store (§2.4-2.6).

**Cost.** The check replaces `init()`, which today runs on every cold process: one
`executeMultiple`, four `PRAGMA table_info` reads and three `CREATE INDEX IF NOT EXISTS`, eight
serial round trips (`db.ts:153-297`). Rem's day had 28 cold starts (01c §2.1). So the owner check
is seven round trips cheaper per cold open than what it replaces; schema changes move to an
explicit migration (§3.5).

### 2.4 Layer 4: caches, process state and background tasks

**The Data Cache.** One helper, `userCache` in a new `src/lib/user-cache.ts`, is the only place
`unstable_cache` may be called (a static test, §5.3). For each call it creates
`unstable_cache(fn, ["u", String(uid), ...keyParts], { revalidate, tags: ["u:" + uid] })` and
invokes it as `fn(uid, ...args)`. Next 16.2.6 builds the key from the callback's source text, the
key parts and `JSON.stringify` of the arguments (01b §3.1, read from the published package), so the
uid separates entries twice over, and a closure-captured id, which Next cannot see, has no way in.
The tag lets account deletion purge the user's entries (§12). Moving every key also strands all
single-user entries at the first deploy, so none of them can be served to the new code (01b §3.1).
All seven wrappers move onto it (`db.ts:983, 1082, 1176, 1181, 1600, 1615, 1906`); the shape tokens
(`LIBRARY_INDEX_SHAPE`, `HISTORY_INDEX_SHAPE`) stay in the key parts as today.

**The owner stamp.** `userCache` stores `{ o: uid, v: value }` and checks `o === uid` on every
return. On a mismatch it logs an `isolation` event and returns `fn(uid, ...args)` uncached, the
right user's data, slower. The check is what turns a cache-key mistake from a leak into a slow
request, in production. It also covers a case no unit test sees: 01b §8 could not rule out that
Preview and Production share the Data Cache, and a Preview built from a buggy branch would write
entries under the same keys production reads, since a key carries the callback's source and not the
deployment.

**React `cache()` boxes.** `tokenBox` (`auth.ts:73`), `seqBox` (`db.ts:402`) and `orderedRealPlays`
(`db.ts:854`) take the uid as their argument; React's `cache()` keys on arguments. Whether
`cache()` is active inside a route handler is unverified (01b §3.3); keyed boxes make the answer
irrelevant.

**Module state.** Every piece of it, and what it becomes:

| state | where | becomes |
|---|---|---|
| in-flight refresh | `auth.ts:188-196` | `Map<UserId, Promise<Tokens>>`; plus the owner check of §2.5, so a shared promise would fail an assertion rather than hand one user's tokens to another (01e A2) |
| playlist-list cache | `src/lib/spotify/resources.ts:81-104` | removed. It saves a second `/me/playlists` read within 60 s on one instance, for a list the library sync reads every 30 minutes, and keyed or not it is the one cache that would store A's library as B's (01b A6) |
| running library sync | `src/lib/playlists-sync.ts:22, 50-54` | `Map<UserId, string>` |
| unique-song recompute throttle | `db.ts:1960` | per uid |
| store-size memo for the ledger model | `db.ts:2887` | per uid |
| Spotify cooldown | `src/lib/spotify/client.ts:48`; `meta.spotify_cooldown_until` | stays app-wide, split by bucket (01c S4): Spotify's rate limit is per app and its quota per developer account (01f §1.4), so a ban is everyone's |
| task registry | `src/lib/tasks/registry.ts:21-23` | each task records its owner; `/api/tasks/[id]` answers 404 to anyone else (01b S7) |

A static test lists every top-level `let`, module-scope `new Map(` and `globalThis` assignment under
`src/` and fails on one that is not in a reviewed allowlist, where each entry says how it is keyed
or why it is not per user (§5.3). If a per-user server cache is later added to now-playing (01c
§5.5 suggests one to dedupe devices), it is keyed by uid like everything here; a shared one would
show one person's live playback to another.

**Background work.** The cron's per-user step (§6.2) receives its `UserStore`, its token getter and
its deadline as arguments and touches nothing global except the app database's queue row and the
app-wide cooldown. Background tasks bind their token getter to the uid when they are created (01e
A16).

**What this layer stops.** M4, M5, M8. **Cost.** A few bytes per cached value and one integer
compare per cached read. Per-user entries share nothing across users, which loses nothing: no cached
value today is legitimately the same for two users.

### 2.5 Layer 5: Spotify credentials that carry their owner

- **Tokens carry their owner.** Decrypting a token row yields `{ uid, accessToken, refreshToken,
  expiresAt }`. `setTokens(uid, t)` asserts `t.uid === uid`. `getSpotifyFor(user)` builds the
  Spotify client from a token object and asserts its `uid` is the user's; the client attributes
  every call to that uid in `api_log` (§3.4). A future refactor that shares a promise or a cache
  across users fails an assertion on the first mixed call instead of acting on someone else's
  account. Cost: one integer compare per Spotify call.
- **The ciphertext is bound to its row.** AES-256-GCM with associated data
  `lazyboy:tokens:v1:<uid>:<env>` (§4). A blob copied into another user's row fails to decrypt,
  which I checked with the scheme itself (§17: the swapped associated data is refused). That catches
  a row-level mix-up in SQL or by hand; it cannot catch the wrong plaintext encrypted for the right
  user, which is what the owner field above is for.
- **Locks and in-flight refreshes per user**: `lock:spotify_refresh:<uid>:<env>` in the app
  database, and the in-flight map of §2.4 (01e A2, A4).
- **The sign-in profile read is never cached.** `spotifyUserinfo` fetches `/v1/me` with no `cache`
  option (`src/lib/spotify/userinfo.ts:29-31`) and relies on Next 16's default of not caching
  `fetch`. It gets `cache: "no-store"` explicitly, because this is the one fetch whose cached answer
  would bind one person's sign-in to another's account. The app's own Spotify client already sets
  it (`src/lib/spotify/client.ts:107`).

**What it stops.** M6, and M12 together with §10.2.

### 2.6 Layer 6: the browser

The browser never learns a user id. The `(app)` layout renders an opaque key,
`hk = base64url(HMAC-SHA256(HK_SECRET, "hk:" + uid))[0:16]`, computed on the server (0.86 µs,
measured, §17), and everything below keys on it:

- **ETags**: `"lib-<shape>-<hk>-<version>-<day>"` and the same for history (today
  `src/app/api/search/library/route.ts:39`, `history/route.ts:26`). Per-user version counters are
  small integers that collide across users (01a §5), so without `hk` a shared browser profile could
  get a 304 for the previous user's body.
- **Immutable segment URLs** (§7): `/api/search/h/<hk>/<segment>?v=<version>`, served with
  `Cache-Control: private, max-age=31536000, immutable` (01d O3). Immutable means the browser never
  asks again, so the per-user part has to be in the URL; a version alone would let user B's page
  read user A's cached segment with no request at all. The server compares the path's `hk` with the
  session's and answers 404 on a mismatch, and it builds every body from the session's database,
  never from the path.
- **Bodies carry their owner**: every payload includes `u: hk`, and the client drops any body, from
  the network, the HTTP cache or IndexedDB, whose `u` is not the page's `hk`.
- **Storage keys** are prefixed with `hk`: `lb-days`, `lb-nowplaying`, `clean:active`, phase E's
  IndexedDB store, and the `lb-nowplaying-leader` Web Lock and BroadcastChannel names, so two users'
  tabs in one browser neither read nor relay each other's state (01b §3.6).
- **Sign-out** clears that storage in client code before the sign-out form submits, and the response
  sends `Clear-Site-Data: "cache", "storage"` where the browser honours it (support not checked; the
  client-side clear is the one relied on).

`HK_SECRET` is its own Production secret. Rotating it changes every `hk`, which re-keys browser
caches and costs one cold visit; it unlocks nothing.

**What it stops.** M7. **Cost.** Microseconds on the server; on a shared browser, two users no longer
thrash one HTTP cache entry.

### 2.7 The shared remainder: app database, telemetry, operator views, scripts

Some state is shared by nature. The design keeps it small, in few places, and lists every
statement.

**The app database** (`src/lib/app-db.ts`, schema in §3.1). Fifteen functions, all of them in one
file a reviewer can read in one sitting:

| function | statement shape | takes a uid |
|---|---|---|
| `sessionRow(uid, env)` | `users LEFT JOIN user_tokens` on the uid: status, epoch, admin, db location, token blob | yes |
| `userByAccount(accountId)` | point read on `users.account_id` (sign-in, returning user) | no: sign-in has no uid yet |
| `claimInvite(spotifyId, accountId, terms)` | compare-and-set from `invited` to `active` (§10.2) | no: same |
| `userDbLocation(uid)` | point read of `db_url` (client open) | yes |
| `writeTokens`, `clearTokensIfStale` | upsert / conditional delete on `(uid, env)` | yes |
| `acquireLock`, `releaseLock` | today's compare-and-set on `app_meta`, names carrying the uid | yes (in the name) |
| `claimDueUsers(now, owner, leaseMs)` | one `UPDATE … RETURNING uid` over due rows | no: cross-user by design |
| `releaseUser(uid, owner, next)` | lease release and next due times | yes |
| `setStatus(uid, …)`, `bumpEpoch(uid)` | point updates | yes |
| `listUsers()` | admin page and the backup job | no: admin only |
| `getGlobal(key)`, `setGlobal(key, v)` | the two global settings (§3.3) | no: global by meaning |

The six that take no uid are cross-user by design, and each has a test of its own (§5.2, T6).

**Telemetry** (`api_log`, `client_metrics`, `usage_ledger`, on the Zenbook after STORE_MIGRATION).
`api_log` and `client_metrics` gain a nullable `user_id`; only admins read them (`/usage`); account
deletion deletes by `user_id` (§12); the `handoff` beacon stops sending song and playlist names
(01a §10), so the operator's view holds operational data and almost no listening.

**Operator views.** `/usage` and any admin page require `user.admin`, a column set for uid 1 by the
migration (§9). It is never derived from `me_id` or anything a sync writes (01b E2, 01e §5.4).

**Scripts** (`scripts/backfill-from-backstop.mjs`, `import-extended-history.mjs`, `import-tail.mjs`,
`verify-derived.mjs`, `bench-reads.mjs`): `--user <id>` is required; the script opens only that
user's database through the same owner check. `backfill-from-backstop.mjs` refuses any user but the
admin, because the recorder captures only Rem (01c §5.7).

**Preview and dev.** Preview deployments get no store variables (01b S14), so a branch's code can
neither read production nor migrate it. Dev runs on local files (`data/app.db`,
`data/<db_name>.db`) with a dev token key; once a friend exists, `.env.local` holds no production
store token (01e §5.9). This is what keeps M11 from writing anyone's production rows.

### 2.8 Every bug class against the layers

"Prevents" means the mistake cannot be written or does no harm; "detects" means a test fails or the
running app refuses. Test ids are §5's.

| class | prevents | detects |
|---|---|---|
| M1 statement forgets the user | per-user databases (2.1) | T1 (B's file unchanged by every A call) |
| M2 id from request input | `UserId` brand (2.2) | static S2 (no casts); T3 (B's id in a path or body with A's session returns A's data or a refusal) |
| M3 read before or without the gate | a read needs a `UserId` (2.2) | T3 (every entry point with no session: refused, zero store opens) |
| M4 cache key without the user | `userCache` (2.4) | T2 (faithful stub, equal counters); owner stamp at runtime |
| M5 shared process state | keyed maps, removed cache (2.4) | static S4 (module-state allowlist); T4 (two users in one invocation) |
| M6 wrong token | per-user rows, locks, in-flight map (2.5) | owner assertion at runtime; T5 (bearer per user in the scripted fetch) |
| M7 browser state across users | `hk` keys, URLs and stamps (2.6) | T7 (ETag, segment path, stamp, storage clear) |
| M8 background work mixing users | per-user step with explicit arguments (2.4, §6) | T4 |
| M9 wrong user-to-database mapping | random database names, written once (2.3, §10.1) | owner check on every open (runtime); T8 |
| M10 shared tables and operator views | `app-db.ts` with 15 listed functions; admin flag (2.7) | T6; T3 for `/usage` as a non-admin |
| M11 scripts and dev on production | `--user` required; dev on local files; Preview without store variables (2.7) | T10 (a script without `--user` refuses) |
| M12 sign-in bound to the wrong account | `account_id` key, compare-and-set claim, no-store profile read (2.5, §10.2) | T9 (double claim, missing `account_id`, changed `id`) |
| M13 shared quotas | per-user fair share of the scarce bucket (§6.4); plan choices (§15) | per-database usage on `/usage`; `api_log.user_id` attribution |

### 2.9 What isolation costs

| what | per request | per cron tick | how known |
|---|---|---|---|
| identity, status and token in one query | no extra round trip: it replaces today's token read (`auth.ts:73-78`) with one join (01e §5.1) | the claim returns the due users; one token read per due user, as today | from the code |
| gate before reads | Home only: +1 round trip, ~15 ms at R1's target (40-210 ms medians on today's Funnel, STORE_MIGRATION §1); other entry points already gate first | none | estimate |
| owner check on open | none warm; 7 fewer round trips per cold open than `init()` | same | from the code (2.3) |
| token decrypt / encrypt | 1.67 µs / 2.67 µs | the same per due user | measured, §17 |
| `hk` | 0.86 µs | none | measured, §17 |
| owner stamp on cached values | a few bytes and a compare | none | from the design |
| a database per user | none | none | §2.1 |
| migrations and backups | none | none; a loop over N+1 databases nightly and per schema change | §3.5, §8 |
| tests | none | none | the isolation suite adds files to `npm test`; its time is unmeasured (no `node_modules` in this checkout) |

Target I$ holds: one round trip on Home, microseconds elsewhere.

## 3. Data model: how every table and meta key gets a user

Two rules decide where everything goes. Listening data and everything derived from it lives in the
user's own database and nowhere else. The app database holds identity, scheduling and ciphertext,
and no listening data at all, so a mistake in its fifteen functions can mis-schedule or lock out a
user but cannot show one person's history to another.

### 3.1 The app database, `lazyboy-app`

```sql
CREATE TABLE users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT, -- the uid; AUTOINCREMENT: never reused
  account_id            TEXT UNIQUE,     -- Spotify account_id (immutable); NULL until claimed and after deletion
  spotify_id            TEXT,            -- Spotify id (mutable): what an invite matches on; refreshed at sign-in
  db_name               TEXT NOT NULL UNIQUE,  -- 'lazyboy' for uid 1, 'lb-u-<random>' for everyone else
  db_url                TEXT NOT NULL UNIQUE,  -- https:// on Turso; file: in dev and tests
  status                TEXT NOT NULL,   -- invited | active | needs_reconnect | disabled | deleting | deleted
  is_admin              INTEGER NOT NULL DEFAULT 0,
  session_epoch         INTEGER NOT NULL DEFAULT 0,
  terms_version         TEXT,
  terms_accepted_at     INTEGER,
  invited_at            INTEGER NOT NULL,
  claimed_at            INTEGER,
  deletion_requested_at INTEGER,
  deleted_at            INTEGER
);
CREATE TABLE user_tokens (
  uid        INTEGER PRIMARY KEY,
  blob       TEXT NOT NULL,      -- 'v1.' || base64url(iv ‖ ciphertext ‖ tag), §4
  expires_at INTEGER NOT NULL,   -- plaintext, so the cron sees who needs a refresh without decrypting
  granted_at INTEGER NOT NULL    -- the last authorization: Spotify's six-month clock (01e §5.7)
);
CREATE TABLE sync_state (        -- 01c §5.2's due queue, scheduling fields only
  uid             INTEGER PRIMARY KEY,
  state           TEXT NOT NULL, -- active | idle | backoff | needs_reauth | removed
  next_probe_at   INTEGER NOT NULL,
  next_harvest_at INTEGER,
  next_rescan_at  INTEGER,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,          -- an error code, never a message body
  last_ok_at      INTEGER,
  lease_owner     TEXT,
  lease_until     INTEGER,
  quota_day       TEXT,          -- the recently-played quota day rp_calls counts (§6.4)
  rp_calls        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sync_due ON sync_state (next_probe_at);
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
```

Choices in it, with the reason for each:

- **An integer uid, with `account_id` as an attribute.** 01a §8.4 measured an integer key at 2% of
  per-play storage against 57% for a text id, but in this design no per-play row carries a user, so
  the integer's real advantages are elsewhere: it is short in cache keys and the HMAC input, it is
  not a Spotify identifier, and `AUTOINCREMENT` means a deleted user's id never comes back, so a
  stale cookie or cache entry for it cannot match a newcomer.
- **`account_id`, not Spotify's `id`, is the link to the account**, as Spotify now asks ("Do not use
  this field for account linking — use account_id instead, which is immutable", quoted in 01f §1.5
  and 01e §1.1). `spotify_id` stays as an attribute because it is what Rem can see before someone
  signs in (it is in their profile URL), so invites match on it once (§10).
- **No `env` column on tokens**, unlike 01e §5.2's sketch. Today one store holds a production and a
  dev token row (`db.ts:2511-2512`); here dev runs its own app database on a local file (§2.7), so
  production's app database never holds a dev grant.
- **`sync_state` holds times and counters, not what was playing.** 01c §5.2's change gate compares
  the last probe's track and progress; those stay in the user's own `meta`, next to today's
  `player_last_active` and `rp_last_harvest` (`db.ts:2364-2374`).
- **Invites are `users` rows in status `invited`**, with the database already provisioned (§10.1).
  One table, one claim statement, and the owner check has an `owner_uid` to compare from the first
  sign-in on.

`app_meta` keys: `schema_version`; `cooldown:<bucket>` (today's `spotify_cooldown_until`, split by
quota bucket as 01c S4 recommends); `played_at_convention` (a fact about Spotify's API, computed
from the admin's plays); `lock:spotify_refresh:<uid>`.

### 3.2 A user database

Today's seven core tables with today's columns, keys and indexes (`db.ts:158-209`, the `ALTER`s at
`:244-295`), so every plan 01a measured with `EXPLAIN QUERY PLAN` (01a §4.2) holds unchanged, and
01a §9.2's "user-led" timings are what each user gets without a single new index. Two `meta` keys
are new: `owner_uid` (written once, §2.3) and `schema_version` (§3.5). One changes meaning:
`user_tz` (an IANA zone name sent by the browser) replaces the fixed `HOME_TZ = "America/New_York"`
(`db.ts:1270`) and the last-browser-wins `user_tz_offset` for that user's write-path payloads (01a
D24). Size: Rem's core is 11.87 MB (01a §2); a newcomer with a library like Rem's starts near
3.3 MB (01a §9.1). `tracks` is per user, so two users who play the same songs store them twice; at
most ~4.2 MB per user, 01a §8.1's ceiling for the overlap.

### 3.3 Every table and `meta` key

The census of 01a §2-3, with where each item goes:

| today | where it goes | how it is tied to one user |
|---|---|---|
| `tracks`, `plays`, `contexts`, `playlists`, `playlist_tracks`, `saved_tracks` | the user's database | by being in it. Per-user `contexts` also fixes the shared negative cache (01a D25): one user's 403 no longer hides a name from another for 30 days |
| `meta`: `last_sync`, `write_seq`, `library_seq`, `slow_seq_pub`, `home_payload`, `alltime_stats`, `alltime_at`, `unique_song_count`, `contexts_full_check_at`, `playlists_synced_at`, `library_synced_at`, `library_scan_attempt_at`, `saved_synced_at`, `liked_total`, `liked_top_added_at`, `plsnap:*`, `player_last_active`, `rp_last_harvest`, `clean_backup_pref`, `lock:clean:*` | the user's database | by being in it. The version markers become per user without a line of code, which is what stops one user's plays from invalidating every other user's caches (01a D21). Two users cleaning one collaborative playlist stop blocking each other (01b §3.5) |
| `meta.me_id` | the user's database | written only by that user's own library sync with that user's own token, so it is right by construction; still used for the owned-playlist filter (`db.ts:2297`) and the page's `isMine`; **never** again read for sign-in (`src/lib/owner.ts` goes, §10) |
| `meta.user_tz_offset` and `HOME_TZ` | `user_tz` in the user's database | by being in it |
| `meta.spotify_tokens` (production) | `user_tokens`, encrypted (§4) | `uid` primary key and the associated data |
| `meta.spotify_tokens_dev` | dev's own local app database | not in production at all |
| `meta.lock:spotify_refresh` | `app_meta`, `lock:spotify_refresh:<uid>` | uid in the name |
| `meta.spotify_cooldown_until` | `app_meta`, `cooldown:<bucket>` | global by meaning: a ban is the app's (01f §1.4) |
| `meta.played_at_convention` | `app_meta` | global by meaning |
| `meta.last_sync_added`, `meta.pltracks_at:*` | dropped by the migration | dead: no reader (01a §3) |
| `api_log`, `client_metrics` | telemetry store, plus nullable `user_id` | the column; deletion deletes by it (§12) |
| `usage_ledger` | telemetry store, unchanged | global; per-user store usage comes from Turso's per-database numbers instead (§2.1) |

What changes in `db.ts`'s SQL: nothing in the seven tables' statements. The token, lock and
cooldown functions (`db.ts:2504-2565`, `2376-2392`) move to `app-db.ts`; the scripts gain
`--user`.

### 3.4 Telemetry

`api_log` gains `user_id INTEGER` (nullable: some calls belong to no user, such as the token
endpoint before sign-in completes), written from the token's owner (§2.5). That is what lets the
quota question of 01c §4 be answered at all: when a ban lands, whose harvests spent the bucket.
`client_metrics` gains `user_id`, set from the session in `/api/metrics` (today the row carries a
client-chosen tab id only, 01b C7). Neither gets a new index: both are pruned at 30 days once
STORE_MIGRATION's daily route runs (its §6 item 7; 01a D32), so a deletion's `DELETE … WHERE
user_id = ?` scans at most a month of rows, once.

### 3.5 Schema versions and migrations, replacing `init()`

`init()` (`db.ts:153-297`) cannot carry a multi-database world: it runs on any cold instance,
concurrently, with writers live (01a §8.6), and with N databases it would run N times per cold
process. It is replaced by three pieces:

1. **Declared versions.** The code carries `USER_SCHEMA` and `APP_SCHEMA`. The open check of §2.3
   compares `meta.schema_version`; a database behind the code is refused for that user only.
2. **Provisioning** creates a new user database at the current version in one `executeMultiple`
   (today's `CREATE` block for the seven tables, with every later `ALTER` folded in) plus
   `owner_uid` and `schema_version` (§10.1).
3. **`scripts/migrate.mjs --all`**, run by hand from the Mac with the pingers paused for its
   duration (STORE_MIGRATION §8 step 2's discipline): for the app database and then each user
   database in turn, it applies the pending steps in one transaction and bumps `schema_version`. At
   six databases this takes seconds.

Deploy order for a schema change stays what it is today, looped: an additive step first (old code
tolerates it), then the deploy that needs it, then any destructive step. Mixed versions are expected
for the minutes a migration runs, and they are per user, never inside one table. Preview cannot run
any of this against production, because Preview has no store variables (§2.7).

## 4. Per-user tokens, encrypted at rest

This section follows 01e §5.2-5.3, which designed the scheme; what changes is the key (the uid,
§3.1) and the owner field of §2.5.

### 4.1 The scheme

- **AES-256-GCM** from Node's built-in `crypto`; a random 12-byte IV per write; stored as
  `v1.<base64url(iv ‖ ciphertext ‖ tag)>`, where `v1` names the key.
- **Associated data** `lazyboy:tokens:v1:<uid>`. A ciphertext moved to another user's row fails to
  authenticate (checked, §17), so someone with write access to the app database but not the key
  cannot graft a victim's grant onto their own account (01e §5.3).
- **Plaintext columns**: `uid`, `expires_at`, `granted_at`. Both tokens sit in the one blob.
- **Keys**: `TOKEN_KEYS="v2:<base64 32 bytes>,v1:<…>"`, the first one writes and reads pick by
  prefix; a Vercel Secret in Production only. Dev uses its own key and its own local app database,
  so the production key never sits in `.env.local`. A copy in Rem's password manager is the backup;
  losing the key costs every user one sign-in and nothing else.
- **Rotation**: put a new key first and redeploy; active users re-encrypt at their next refresh,
  about hourly; a one-off script re-encrypts the rest; the old key goes once no blob starts with
  its prefix.
- **A blob that fails to decrypt** is no token: the user goes to `needs_reconnect`, and the log
  line carries the uid, never the blob.
- **Cost, measured** (§17): 1.67 µs to decrypt and 2.67 µs to encrypt a 450-byte token blob on the
  Mac, against a store round trip of ~15 ms at R1's target.

### 4.2 The three paths that touch tokens

**Every request.** The jwt callback reads identity and the token in one query:

```sql
SELECT u.status, u.session_epoch, u.is_admin, u.db_url, t.blob, t.expires_at
FROM users u LEFT JOIN user_tokens t ON t.uid = u.id
WHERE u.id = :uid
```

It returns `null`, so the request is signed out, when the cookie has no `uid` (every cookie minted
before phase 1, which also ends 01b E1 / 01e F1 for good), when the user is not `active` or
`needs_reconnect`, or when the cookie's epoch is not `session_epoch`. One round trip, as today's
token read is. The result goes into the request box keyed by uid (§2.4).

**Sign-in.** The sign-in pass of the jwt callback writes the token row for the uid the sign-in
resolved (§10.2), sets `token.uid` and `token.ep` from the users row, never from the incoming
cookie or the profile alone, and stores nothing else in the cookie. The two paths that park Spotify
tokens inside the cookie when the store write fails (`auth.ts:367-374`, `388-405`) go: a token in a
cookie is bound to no user row and is invisible to the cron, so a sign-in that cannot write its
token row fails visibly and is retried (01e A18).

**Refresh.** `coordinatedRefresh`, `waitForFreshToken`, `clearTokensIfStale` and
`getValidAccessToken` (`auth.ts:170-289`) all take the uid. The cross-instance lock is
`lock:spotify_refresh:<uid>`; the in-process in-flight map is keyed by uid; every token object
carries its owner (§2.5). `clearTokensIfStale` keeps its wave-2 rule unchanged within one row.
The token core moves out of `auth.ts` into a module with no `next-auth` import, so the simulated
environment can run it (01e §5.2; today's tests cannot load `auth.ts`, 01e §2.7). Write load: about
24 refreshes per user per day, each a token write plus a lock acquire and release, ~72 writes per
user per day (01e §5.2's estimate).

### 4.3 What encryption covers, and the other secrets

Encryption at rest protects every copy of the token rows outside the Vercel runtime: the app
database's backups, Turso's own retention, any dump or scratch copy, a dev machine. Those copies
matter more than usual for this app, because Spotify does not rotate its refresh tokens (unchanged
across two weeks of hourly refreshes) and documents a six-month lifetime, so a copied refresh token
stays a live 13-scope credential for months (01e F2). It does not protect against code running in
production, which holds the key.

The other secrets, and what this design asks of each:

| secret | today | in this design |
|---|---|---|
| `AUTH_SECRET` | Production and Preview, 133 days old (01e §3.1) | rotate now (01e F1, §16). With a uid in every session, a forged cookie can name any user, so it becomes the key to every account's in-app session: Production only, and Preview gets its own |
| `TOKEN_KEYS` | – | Production only, Secret; dev has its own |
| `HK_SECRET` | – | Production only; rotation is harmless (§2.6) |
| Turso group token (runtime) | a single-database token after STORE_MIGRATION (its §5) | one group token, read-write, Production only; Preview gets none (§2.7) |
| Turso group token, read-only | – | the backup job only (§8) |
| `TURSO_PLATFORM_TOKEN` | in the runtime for `/usage` and the dormant guard (01e §3.1) | kept in the runtime for two narrow uses, destroying a departed user's database and the daily usage read (§12 argues why); provisioning stays a script on the Mac (§10.1) |
| `CRON_SECRET` | the cron routes | unchanged; with N users its holder can make the cron fan out on demand, so the per-user lease (§6.2) also caps what a leaked secret can spend |

## 5. Isolation tests

The tests live in the existing simulated environment (`npm test`: vitest against throwaway local
SQLite files and a scripted global `fetch`, `tests/setup.ts`, `vitest.config.ts`), so they run on
every change and touch no store, no Spotify and no Vercel. Each is written before the code it
proves, red first (§14's order), as the repo's rules require for non-trivial logic.

### 5.1 What the harness gains

- **Three database files per test file**, not one (today `tests/setup.ts:7-9` makes one `sim.db`):
  `app.db`, `u1.db`, `u2.db` in the per-file temp directory, with `users` rows for uid 1 and uid 2
  created by the same provisioning code production uses (§10.1), so provisioning is under test too.
- **A two-user seed with deliberate collisions**: the same track id at the same `played_at` in both
  users (01a D17); the same playlist id with different members (D14); the same context URI named
  for one user and negative-cached for the other (D25); interleaved timelines (D18); and equal
  `write_seq`, `library_seq` and `slow_seq_pub` values, so a cache key that lacks the user collides
  (01a §5). Every text column carries a marker, `A-only-…` or `B-only-…`, so "nothing of A's
  reached B" is a substring check over the serialized output.
- **A faithful `unstable_cache` stub.** Today's stub is a pass-through (`tests/stubs/next-cache.ts:4-10`),
  so no test can see a key collision. The new one is a Map keyed the way Next 16.2.6 keys
  (`fn.toString()`, the key parts, `JSON.stringify(args)`; 01b §3.1), honours `tags` and records
  `revalidateTag` calls.
- **A scripted Spotify that answers per bearer token**: different profiles, players, plays and
  playlists for A's and B's access tokens, and a log of which bearer each call carried.
- **A session switch**: the `vi.mock("@/lib/auth")` pattern of `tests/now-playing-route.test.ts:13-16`,
  returning A's, B's or no session; and, once the token core leaves `auth.ts` (§4.2), the real jwt
  callback body run against the simulated app database.
- **An open counter** on `userClient`, per uid, and **file hashes**: sha256 of `u2.db` (and any
  `-wal`) before and after an operation as user A. The hash check is total: it catches a write to
  B's database through any path, including ones nobody listed.

### 5.2 The suites

| id | what it runs | what must hold | classes |
|---|---|---|---|
| T1 | every method of `UserStore`, enumerated from the object so a new method is covered automatically, with arguments from a fixture table, as A and then as B | the other user's file hash unchanged; no other-user marker in the return value | M1 |
| T2 | the seven cached reads (`db.ts:983-1914`'s wrappers, now on `userCache`) as A then B, counters equal; then a forged entry under B's key stamped with A | B never gets an A marker; the forged entry is refused, B's data returned uncached, an `isolation` event logged | M4 |
| T3 | every page, every `"use server"` export and every route handler under `src/app`, found by globbing the files and importing them: (a) with no session; (b) as B; (c) as B with A's identifiers in the input (A's playlist id on `/playlists/[id]`, A's task id on `/api/tasks/[id]`, A's `hk` in a segment path); (d) `/usage` as non-admin B | (a) refused, zero user-database opens; (b) no A marker anywhere, A's file unchanged, every Spotify call carried B's bearer; (c) B's own data or a 404, never A's (01b B4, B9; 01d §4.3 test 1); (d) refused. Exempt from (a), by a named list: `/`, `/login`, `/api/build`, `/api/auth/*`, `/api/cron/*` (T4 covers the cron) | M2, M3, M6, M10 |
| T4 | one cron tick with A and B due and both tokens expired | each database gets only its own plays and playlists; one refresh per user, each user its own token (01e §5.2 test 1); A's lock does not delay B (test 2); A failing (a 403 "not registered", `invalid_grant`, a hang past the deadline) leaves B's outcome `ok`; the tick answers 200 with both outcomes; a library sync for A then B within 60 s on one instance stores each user's own list (the `playlistsCache` trap, 01b A6) | M5, M6, M8 |
| T5 | the token core | A's blob in B's row fails to decrypt and B goes `needs_reconnect`, A untouched; `invalid_grant` for A clears A only (01e test 3); a token object owned by A passed for B throws; a cookie with no uid, an unknown uid, a stale epoch or a disabled user yields no session (test 5); no token row means no Spotify call (test 6) | M6 |
| T6 | the six app-database functions without a uid (§2.7) | `claimDueUsers` never returns a leased user and never the same user to two concurrent claims; an invite is claimed once; `userByAccount` matches exactly; `getGlobal`/`setGlobal` accept only the listed keys | M10 |
| T7 | the search routes and the client storage module (behind a storage interface, as STORE_MIGRATION §10 plans for phase E) | equal versions give A and B different ETags; B sending A's ETag gets 200 with B's body, never 304 (01d §4.3 test 3); a segment path with A's `hk` under B's session is 404; a stored body whose `u` is not the page's is discarded; sign-out empties the store; no ETag contains a Spotify id (01d test 6) | M7 |
| T8 | a users row pointing uid 2 at `u1.db`; a database at the wrong schema version | `forUser(2)` refuses before any read or write, logs, A's hash unchanged; the wrong version is refused for that user only | M9 |
| T9 | sign-in | an invite is claimed once; a profile without `account_id` is refused; a returning user is found by `account_id` after their Spotify `id` changed; Y cannot claim X's invite | M12 |
| T10 | every script | exits non-zero without `--user`; with `--user 2` touches only `u2.db`; the backstop replay refuses any user but the admin | M11 |
| T11 | account deletion for B (§12) | B's next request has no session; B's token row, queue row and telemetry rows are gone; B's database is destroyed (in tests, the file); `revalidateTag("u:2")` was called; A's hash unchanged; a second run is a no-op; the job refuses uid 1's database and any database whose `owner_uid` is not the departing uid | M1, M9 |
| T12 | the phase-2 migration on a local copy of a nightly snapshot (§9), run by hand, not in CI, since it needs Rem's data | per-table counts equal; `verify-derived.mjs --user 1` green; `meta` key set equal less the moved and dropped keys; `owner_uid = 1`; the moved token decrypts to the original | migration |

### 5.3 Static checks (also in `npm test`)

| id | check |
|---|---|
| S1 | `unstable_cache(` appears only in `src/lib/user-cache.ts` |
| S2 | no `as UserId` (or a double cast to it) outside `src/lib/identity.ts`; its minting helper is imported only by the gate, the cron's claim and the script helper |
| S3 | no per-user function is exported from `db.ts` at module level; `app-db.ts` exports exactly the fifteen functions of §2.7 (a snapshot: adding one means updating the list, which a reviewer sees) |
| S4 | every top-level `let`, module-scope `new Map(` and `globalThis` write under `src/` is on a reviewed allowlist that says how it is keyed or why it is not per user |
| S5 | every `fetch` to `api.spotify.com` or `accounts.spotify.com` sets `cache: "no-store"` or goes through `src/lib/spotify/client.ts` |
| S6 | every `localStorage`, `sessionStorage`, IndexedDB, `BroadcastChannel` and Web Lock name in `src/` is built by the `hk`-prefixing helper |

### 5.4 In production

- **Isolation events.** The owner check on open, the cache stamp, the token-owner assertion and the
  segment `hk` check each log an `isolation` event (`client_metrics`, with the uid and a code, no
  data) and the first lines of `/usage` show the count for the admin. The expected count is zero;
  any other number is a bug with its code path attached.
- **An adversarial review** of the isolation change in a fresh context, told to find a cross-user
  path, before it deploys: the pattern lanes 1902 and 1906 follow for STORE_MIGRATION (its §7).
- **A canary account** is optional and Rem's call (§16): a second Spotify account he controls,
  signed in on another browser for phase 4's first week, checked by eye to see only its own data. It
  holds one of the five allowlist places while it exists.

## 6. Sync fan-out within Spotify's limits

01c designed the fan-out (its §5); this design adopts it and adds what isolation asks of it: each
user's step can touch only that user, one user's failure costs only that user's slot, and one
user's listening cannot spend the shared Spotify budget until everyone is banned.

### 6.1 What binds

- **Five users at most** (target U).
- **Recently-played has a daily budget**, observed at roughly 725-800 calls a quota day for the
  whole app in August's bans, and Spotify documents the development-mode quota as one pool per
  developer account (01f §1.4, 01c §4; one changelog sentence says "a user's quota", so this is the
  largest unknown in the plan). Planning budget, as 01c §5.1 sets it: **450 a quota day**, 60% of
  the observed ban line. `/me` appears to share the bucket (01c §4), which is one reason the rescan
  stops calling it (§6.6).
- **The player endpoints** have never been limited; Rem's cron alone spends ~1,035-1,303 calls a
  day on them (01c §2.7). Their limit is unmeasured.
- **The 30-second rate limit** is per app and unpublished; 18 calls in 30 s have passed without a 429
  (01f §1.4).

### 6.2 The tick

One invocation a minute from the pingers (§6.7), whatever N is, as 01c §5.2 recommends:

1. **Claim.** `claimDueUsers` leases every user whose `next_probe_at` has passed, in one `UPDATE …
   RETURNING uid` on the app database, with a lease owner (the tick's id) and `lease_until = now +
   50 s`. This is also the tick's store health check: if it fails, the tick ends at once (01c §5.2
   step 1). A user leased by an overrunning tick is not due, so two ticks never work on one user.
2. **Step, per user, concurrently**, under `Promise.allSettled` and a 25-second deadline each. The
   step function receives everything it may touch as arguments: the `UserId`, its `UserStore`, a
   token getter bound to that uid, and the deadline. It probes the player, applies the harvest
   policy (§6.3-6.4), records plays into that user's database, and finishes by releasing its lease
   with a compare-and-set on the lease owner, so a step that outlived its lease writes nothing to
   the queue. Writes into the user's database are idempotent by natural key (plays by `(track_id,
   played_at)` within the user's own table), so a step that ran twice records nothing twice (01c
   §5.4 item 8).
3. **At most one library rescan**, for one user, outside the harvest deadlines (§6.6).
4. **Answer 200 with a per-user outcome list** (codes, no data), and non-200 only when step 1
   failed or the owner's own capture has stopped, which is Rem's only alarm today (01c §5.2 step 4).

Users spread across the minute by `hash(uid) mod 60` on their due times, so five users' probes do not
land in the same second (01c §5.2).

### 6.3 Harvest policy, and what it does for freshness

All users harvest **on a track change** (01c §5.3 policy (i)): the step keeps the last probe's track
and progress in the user's own `meta` and harvests when the track changed, a track restarted, or
playback stopped. That is at most one harvest per play, any change a probe missed is inside the 50
plays returned, and the store stays within ~2 minutes of the track's end, which is target F. It
costs ~140 recently-played calls a day for a Rem-like listener with the idle backstop moved from
hourly to every two hours (01c §5.1), and ~60 for a light one (40 plays a day).

### 6.4 A fair share of the scarce bucket

A shared budget couples users: under the documented reading, one person's heavy day can get every
user's capture banned until about 10:50 AM (01f §1.4). No code can make the bucket private, so the
design decides who slows down first:

1. Every user starts the quota day on track-change harvests. The app database counts each user's
   recently-played calls for the quota day (`sync_state.rp_calls`, reset at the day boundary 01f
   §1.4 measured, 14:51 UTC).
2. When the whole app's count reaches **¾ of 450**, any user above an equal share (450 ÷ N) moves to
   **one harvest per 15 minutes of playback** for the rest of the quota day.
3. When the whole app reaches **450**, every user moves to **one per 30 minutes of playback**.
4. In every mode a user is harvested as soon as the probe has counted 40 track changes since their
   last harvest, so nobody loses a play to Spotify's 50-play window, and the backstop runs every two
   hours while idle.
5. Opening the app always gets one on-load harvest, at most once per 15 minutes per user once the
   app is past 450, so what a person sees when they look is current within seconds.

Light listeners are never slowed; the heaviest is slowed first; the app's total stays near the
planning budget. If the passive check of 01c §7.3 finds the quota is per user after all, `450`
becomes a per-user number and everyone stays on track-change harvests (01c §5.1: under the per-user
reading every policy fits).

What this costs in freshness, with the arithmetic in §13.3: Rem plus four light friends stay on
track-change harvests for nearly the whole day; five Rem-like listeners do for about the first 60%
of each listening day and then land within 30 minutes while the app is closed.

### 6.5 Failure isolation

01c §5.4's list, which this design keeps whole: the per-user deadline; per-user tokens, locks and
refresh; a 403 "not registered" read from the body and the user marked `removed`; `invalid_grant`
marking `needs_reconnect` (01e §5.7); every user failing the same way at once read as the owner's
Premium lapsing, backed off as one; 429s split by reason, so a `QUOTA_EXCEEDED` cools only its
bucket; a store failure ending the tick in step 1; idempotent writes; and a new user's first rescan
kept out of the harvest deadline. Each state lives in that user's `sync_state` row, so one user's
`backoff` or `removed` never changes another's schedule.

### 6.6 The open app, now-playing and the rescan

- **`/api/sync`** runs the same per-user step under the same lease, so a visible tab and the cron
  never harvest one user twice in a minute; today an open tab harvests whenever the cron's gate is
  closed (01c §2.4). The browser's zone is written only when it changes (today on every call,
  `src/app/api/sync/route.ts:24-27`).
- **`refreshHistoryAction`** stops calling Spotify and only re-reads the user's store; today it
  harvests on every call with no debounce (`src/app/(app)/history-actions.ts:133`, 01c S6). The
  browser's own provisional plays already cover the moment a track ends.
- **Now-playing** polls every 15 s mid-track instead of 6 s, keeping the end-of-track and focus
  polls (01c §5.5), so five users with a visible tab each stay near the 18-per-30-seconds rate that
  has passed without a 429.
- **The library rescan**: one user per tick, resumable across ticks (it already commits per
  playlist), every 30 minutes while active and every 2-3 hours idle; it stops calling `/me`, whose
  answer (the user's Spotify id) is known from sign-in; and it reads all of a user's playlist
  snapshots in one statement instead of ~110 serial `getMeta` reads (01c §5.6).

### 6.7 Pingers and the recorder

- **A second pinger off the Zenbook**: the cron-job.org job that ran until Aug 10, re-keyed (its
  `CRONJOB_*` settings exist, 01f §3.5), offset a minute from the Zenbook timer. The lease makes a
  double tick harmless, which is why it waits for phase 3 (01c §5.7 b). With both up the app ticks
  every minute; with either down, every two.
- **The recorder** stays Rem's alone and runs hourly instead of every 15 minutes, 24 calls a day in
  the scarce bucket instead of 96 (01c §5.7 a; 01e §5.9). Extending it to friends would put their
  refresh tokens in a plain file on a laptop.

### 6.8 What it costs Vercel

One cron invocation a minute, 1,440 a day, flat in N, plus the open apps' requests (01c §5.8). A
tick lasts as long as its slowest user's step, under the 25-second deadline; at R1's target a
landed play's ~30 store round trips take well under a second (01c §5.8). No `maxDuration` is set
today (01c §5.8); the per-user deadline keeps a tick under a minute whatever the default.

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
