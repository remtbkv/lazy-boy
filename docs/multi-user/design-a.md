# Design A — isolation first: one user can never see or change another's data

Lane 0222_lb_mu_design_a of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. Line numbers are against commit
`774bb21`; `src/`, `scripts/`, `ops/` and `tests/` are identical to `ac6f7fe`, the commit the six
overviews cite (`git diff --stat ac6f7fe HEAD` over those paths is empty). Every claim about the
current system cites `file:line` or an overview section (01a-01f); every number is **[measured]**
with how, or **[estimate]** with the arithmetic. Section 17 lists everything I ran.

Status: complete, Oct 14, 2026.

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
   already checked, in its one store query, that the session's user exists, is `active` or
   `needs_reconnect`, carries the current `session_epoch`, and whether a usable token exists
   (§4.2). `gate()` returns `{ uid, hk, admin, spotify }`
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
  `lazyboy:tokens:v1:<uid>` (§4). A blob copied into another user's row fails to decrypt,
  which I checked with the scheme itself (§17: the swapped associated data is refused). That catches
  a row-level mix-up in SQL or by hand; it cannot catch the wrong plaintext encrypted for the right
  user, which is what the owner field above is for.
- **Locks and in-flight refreshes per user**: `lock:spotify_refresh:<uid>` in the app database,
  and the in-flight map of §2.4 (01e A2, A4).
- **The sign-in profile read is never cached.** `spotifyUserinfo` fetches `/v1/me` with no `cache`
  option (`src/lib/spotify/userinfo.ts:29-31`) and relies on Next 16's default of not caching
  `fetch`. It gets `cache: "no-store"` explicitly, because this is the one fetch whose cached answer
  would bind one person's sign-in to another's account. The app's own Spotify client already sets
  it (`src/lib/spotify/client.ts:107`).

**What it stops.** M6, and M12 together with §10.2.

### 2.6 Layer 6: the browser

The browser never learns a user id: nothing new goes on the `Session` type, which Auth.js serves to
any script on the origin at `GET /api/auth/session` (docs/SECURITY.md). The `(app)` layout renders
an opaque key,
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
caches and costs one cold visit; the key grants access to nothing.

**What it stops.** M7. **Cost.** Microseconds on the server; on a shared browser, two users no longer
thrash one HTTP cache entry.

### 2.7 The shared remainder: app database, telemetry, operator views, scripts

Some state is shared by nature. The design keeps it small, in few places, and lists every
statement.

**The app database** (`src/lib/app-db.ts`, schema in §3.1). Fifteen functions, all of them in one
file a reviewer can read in one sitting:

| function | statement shape | takes a uid |
|---|---|---|
| `sessionRow(uid)` | `users LEFT JOIN user_tokens` on the uid: status, epoch, admin, db location, token blob | yes |
| `userByAccount(accountId)` | point read on `users.account_id` (sign-in, returning user) | no: sign-in has no uid yet |
| `claimInvite(spotifyId, accountId, terms)` | compare-and-set from `invited` to `active` (§10.2) | no: same |
| `userDbLocation(uid)` | point read of `db_url` (client open) | yes |
| `writeTokens`, `clearTokensIfStale` | upsert / conditional delete on the uid's row | yes |
| `acquireLock`, `releaseLock` | today's compare-and-set on `app_meta`, names carrying the uid | yes (in the name) |
| `claimDueUsers(now, owner, leaseMs)` | one `UPDATE … RETURNING uid` over due rows | no: cross-user by design |
| `releaseUser(uid, owner, next)` | lease release and next due times | yes |
| `setStatus(uid, …)`, `bumpEpoch(uid)` | point updates | yes |
| `listUsers()` | admin page and the backup job | no: admin only |
| `getGlobal(key)`, `setGlobal(key, v)` | `app_meta`'s listed keys: the per-bucket cooldowns, `played_at_convention`, `schema_version` (§3.1) | no: global by meaning |

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

**Shared quotas (M13).** A user can only read their own database, but every read counts against the
one Turso budget, and every Spotify call against the one developer account. So the expensive entry
points get per-user limits, which 01b S13 already asks for: `dailyStatsAction`'s `days` (today any
value up to 100,000, and each distinct value is a scan and a new cache entry,
`src/app/(app)/history-actions.ts:67-71`) narrows to the one value the client sends
(`home/den-home.tsx:379`); the `LIKE`
fallback (`searchPlaysAction`) and the playlist re-fetch (`/api/playlists/[id]/tracks`) get a small
per-user rate limit; Spotify's scarce bucket is shared out by §6.4. With friends who were invited by
name this is a guard against accidents more than attacks, but an accident here is everyone's outage.

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
| M13 shared quotas | per-user fair share of the scarce bucket (§6.4); per-user limits on the expensive entry points (2.7); plan choices (§15) | per-database usage on `/usage`; `api_log.user_id` attribution |

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
-- one open invite per Spotify id, so a claim can never match two rows
CREATE UNIQUE INDEX idx_users_open_invite ON users (spotify_id) WHERE status = 'invited';
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

What changes in `db.ts`'s SQL: nothing in the seven tables' statements. The token functions, the
refresh lock and the cooldown (`db.ts:2504-2531`, `2376-2392`) move to `app-db.ts`; the lock
primitive itself (`db.ts:2541-2565`) serves both databases, since the clean lock stays in the user's
own `meta`; the scripts gain `--user`.

### 3.4 Telemetry

`api_log` gains `user_id INTEGER` (nullable, since the rows already there have none), written from
the token's owner on every call through the Spotify client (§2.5). That is what lets the
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
  polls (01c §5.5): about 6 Spotify calls a minute per user, so five users with a visible tab each
  make ~15 calls per 30 s, under the 18 that have passed without a 429.
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

Search keeps today's model: the browser holds the user's library and history and filters them on
every keystroke with no request (`den-home.tsx:497-524`, 01d §1). What changes is how the history
reaches the browser, which 01d showed has to change for Rem alone: the history body is 1.79 MB raw,
86.6% of the Data Cache's 2 MiB item limit, and crosses it around late December 2026, after which
every Home open rebuilds it with a full plays scan and nothing reports it (01d §3.2). This design
takes 01d's remedy and keys every piece of it per user.

### 7.1 What the browser fetches

- **A manifest**, `GET /api/search/manifest`: `{ u, shape, library: v, catalog: v, months: [[month,
  v, plays], …] }`, a few hundred bytes, `private, no-store`. One store read in the user's
  database.
- **The history in monthly segments** (01d O3), one body per (user, UTC month) in today's tuple
  format, plus the catalog rows as their own segment, since they never change and are 58% of
  today's body (01d §2.1): `GET /api/search/h/<hk>/<month>?v=<v>`, `private,
  max-age=31536000, immutable`. A segment rebuild reads one month through `idx_plays_played_at`,
  ~10,000 rows at most for Rem against ~65,000 for today's whole body (01d O3).
- **The library**, one body per user as today (`GET /api/search/l/<hk>?v=<library_seq>`, immutable
  per version), split per playlist later, when a library passes ~12,000 songs (01d O7).
- **A delta at visit start** (01d O4): the plays newer than the newest minute the browser holds,
  ~50 rows; today's `refreshHistoryAction` read, made a scoped GET.
- **Phase E's IndexedDB copy** stores segments under `(hk, kind, segment, version)`, so a repeat
  visit paints search from disk before the network (STORE_MIGRATION §10, 01d O5).
- **Lazy days** (01d O6): a day's rows are built when the day is selected, by binary search on the
  minute bounds, instead of all 21,559 plays up front, which is 199 of today's 264 ms of client work
  at 4× CPU (01d §2.3).

**Segment versions** are per-month counters in the user's own `meta` (`seg_seq:<YYYY-MM>`), bumped
by the writes that can change a closed month: inserts (their `played_at`), the orphan pass (`UPDATE
… RETURNING played_at`), a context name resolving (its plays' months, through `idx_plays_context`),
a track re-tag (through `idx_plays_track`), and an out-of-order insert re-opening its neighbours'
skip verdicts. 01d O3 weighs this against an immutable-facts layout and leans to the counters;
so do I, because each bump site gets a known-answer test (write to an old month: that month's
version moves and no other does), and in a per-user database a missed bump is a stale month for one
user, never someone else's month.

### 7.2 Isolation in the search path

Everything in §2.6 applies; the search path is where it matters most, because it is the one place
that sends whole libraries and histories, and the only one with immutable caching.

- The server takes the user from the session and builds from the session's database. The `hk` in a
  segment or library path selects nothing; it is compared with the session's and a mismatch is a
  404 (T3c, T7).
- Every body carries `u: hk`, and the client discards a body whose `u` is not the page's.
- Every server-side entry goes through `userCache` (uid in the key parts and arguments, the owner
  stamp checked on return, tag `u:<uid>`).
- ETags and URLs carry `hk` and never a Spotify id (01d §4.3 test 6).
- The server fallback while payloads load, `searchHistory`'s `LIKE` (`db.ts:884-904`), runs in the
  user's database, so it cannot surface another user's songs (01d §4.1).
- The in-memory delta patch (`history-actions.ts:140-161` → `den-home.tsx:766-780`) reads the
  user's own newest plays. Today it reads the newest plays of the whole table, and phase E would
  persist anything it patched in (01d §4.1), so this one is a leak that would outlive the request.

### 7.3 Server caching with N users

Each entry is one user's. With segments, an entry is one month (~300 KB raw for a 100-plays-a-day
month, 01d O3), so no user's entry approaches the 2 MiB limit however long their history grows, and
a history import (01d §3.3: ~4.2 MB as one body today) becomes many bounded months. Vercel's Data
Cache is one least-recently-used store shared by every project on the team (01f §2.2), so one
user's entries can evict another's; the cost of an eviction is one month's rebuild, ~4,500-10,000
rows, which is the isolation that matters here: slower, never someone else's. At five users the
footprint is small: 01d §4.2 estimates ~260 MB written a day for 25 typical users under today's
whole-body design and far less with segments.

### 7.4 Order of work

01d §5.2's order, with the isolation pieces placed:

1. **Now, single-user, before December:** lazy days and segments with the catalog as its own segment
   (or 01d O2, the catalog split alone, as a stopgap if segments cannot land by mid-December). Rem
   needs this whether or not anyone else ever signs in.
2. **Phase 1:** the `hk` in URLs, ETags and bodies; `userCache`; T2, T3 and T7 red, then green.
3. **STORE_MIGRATION phase E** storing segments under `(hk, kind, segment, version)`, plus the
   visit-start delta.
4. **Later:** the library per playlist and a Web Worker, when a library passes ~12,000 songs or the
   phone measurement of §13.2 fails.

## 8. The store, and what STORE_MIGRATION should change

### 8.1 The store

**Turso, one database per user, one app database, in group `default` (`aws-us-east-1`).** The
reasons are §2.1's; the alternatives, briefly:

- *One Turso database with a `user_id` column*: the design 01a §8.2-8.6 specifies in full, and the
  one that leaves isolation to more than fifty statements (§2.1).
- *Postgres or Supabase with row-level security*: isolation in the database, at the price of
  rewriting the SQLite SQL and abandoning STORE_MIGRATION (§2.1).
- *sqld namespaces on the Zenbook*: sqld can host several databases, but every user path would stay
  on the laptop that STORE_MIGRATION exists to take off them (its §1, R2).

One fact for the longer term: Turso's pricing page carried a banner at 10:11 PM today, "Turso is
joining Supabase to give every agent its own database". I did not read further; plans and prices
may change. The exposure is small, because each user's data is a plain SQLite database that dumps
to a file (the nightly backups are exactly that, §8.3), so a move to any libSQL or SQLite host is
a copy and a URL change per user.

### 8.2 What multi-user needs from STORE_MIGRATION, and gets

- **The user paths off the Zenbook** (R2): target A's first half rests on it.
- **`lazyboy` becomes Rem's user database as it stands**: the cutover is schema-preserving (its §8
  steps 4-7), and this design changes nothing in the seven tables, so Rem's data never moves again
  (§9).
- **The telemetry split** (its §6 items 1-3) is where `api_log` and `client_metrics` get their
  `user_id` (§3.4).
- **The daily route** (its §6 item 7) brings back retention for `api_log` and `client_metrics` and
  lands Turso's real usage in the ledger daily: per database, once there are several (§2.1).
- **Phase E** (lanes 1905-1906) is the browser cache §7.1 builds on.

### 8.3 What should change before it runs (Oct 15, 8 PM)

Nothing in the cutover itself. Six small edits, all already recommended by an overview, each worth
making because doing it later means doing it twice; none blocks lane 1901:

1. **§10 (lane 1905): key IndexedDB by an opaque key the `(app)` layout renders**, a constant until
   phase 1 ships the real `hk`; stamp each stored body with it; give the store interface a `(key,
   kind, segment, version)` key. Today no user id reaches the browser at all (01b §7 item 1, 01d §6
   item 3, 01e §6 item 3).
2. **§8 step 9: flip Production only**, and give Preview no store variables, so no branch's code can
   read or migrate the new store (01b §7 item 2).
3. **§9 (lane 1904): write the backup as a loop over a list of databases, one file per database**
   (01a §10 item 3), so per-user files exist from the first friend on and a deletion can remove
   them (§12); **and strip `spotify_tokens%` and `lock:%` rows from the backup copies** until
   phase 2 moves the tokens out (01e §6 item 1).
4. **§6 item 7: write `/api/cron/daily` as a loop over users**, one user today (01c §6 item 3).
5. **§3 and R4: name the all-time recompute, not the history payload, as the dominant read, and give
   R4 a growth term** (01c §6 items 1-2; 01a §11.2 and 01d §2.2 reach the same reading). It decides
   which lever comes next (§13.4).
6. **§6 item 8: derive the fence's table list from the schema** rather than writing it out, so new
   tables are fenced without anyone remembering to (01b §7 item 3).

Ordering after it: phase 2's token move lands after lane 1903's cutover and 1904's aftercare,
because the runbook compares one plaintext token row on both stores (its §8 steps 10 and 16; 01b §7).

## 9. Migrating Rem's data with nothing lost

### 9.1 What moves

Almost nothing. After STORE_MIGRATION, Rem's data sits in the Turso database `lazyboy`, and in this
design that database is Rem's user database as it stands: the seven tables are not copied, rebuilt
or re-keyed. Three things change:

| what | change | why it cannot lose data |
|---|---|---|
| the production token row | encrypted into `user_tokens` (uid 1) in the app database; the plaintext row stays in `lazyboy` for a week as the way back | the old and new copies are compared on `expiresAt`, the later wins (STORE_MIGRATION §8 step 10's rule); Spotify does not rotate this app's refresh token (01e F2), so both copies hold the same grant |
| `meta` | adds `owner_uid = 1`, `schema_version`, `user_tz`; drops `spotify_tokens_dev` (dev moves to a local store), the dead `last_sync_added` and `pltracks_at:*` (01a §3), and, after the week, `spotify_tokens` | the dropped keys have no reader; the moved ones are verified first |
| the incident's foreign plays (01b E6) | deleted, with Rem's sign-off on the list (§9.2) | a snapshot first; the list is shown before anything is deleted |

### 9.2 First, the incident's foreign rows

The cron recorded the second account's plays into Rem's history while that account's token sat in
the row (commit `044c9b6`; 01b E6), and `plays` has no column to tell them apart. Rem's own
recorder captured his real plays throughout on its own grant, every 15 minutes, into
`~/lazyboy-recorder/backstop.db` (01c §1, §2.6). So, on a local copy of a nightly snapshot taken
after Rem signed in again:

1. List the plays from the start of Oct 14 to Rem's first sign-in after the incident that are in
   the store and not in `backstop.db` (01e's 9:32 PM probe found `me_id` back on Rem's account, so
   the window closes before then). The recorder reads the last 50 plays every 15 minutes, so a real
   play of Rem's missing from it would need 50 plays in a quarter hour or the recorder down; its
   timer's log shows the second, and the 3 AM reboot is 6-8 minutes (01f §3.3).
2. Show Rem the list (time, track, artist, context). Nothing is deleted without his yes.
3. In one transaction on the store: delete the confirmed rows; set `skipped = NULL` on the play
   after each deleted one, since its listened time and verdict were computed from a foreign
   predecessor (01a D18); reset `contexts` rows resolved during the incident window to unresolved so
   Rem's token re-resolves them; bump `write_seq`.
4. Let the next sync re-rule the reopened verdicts and recompute the all-time totals, then run
   `scripts/verify-derived.mjs`, which checks the derived columns and aggregates against a
   recompute from source (01a §5).

The library tables healed themselves on Rem's next sync (`storePlaylists` rewrites the list and
purges stale snapshots, 01b E6), and `verify-derived` re-checks the orphan flags a foreign library
sync may have moved. This can run any time; after STORE_MIGRATION's aftercare and before phase 2 is
the quiet slot, so the owner tag goes onto clean data.

### 9.3 The phase-2 steps

Preconditions: phase 1 has run for some days (every session carries `uid` 1; `userCache` and the
isolation suite are in); lanes 1903 and 1904 are done; §9.2 is done; a fresh verified backup exists.

1. On the Mac: create `lazyboy-app` in group `default`, apply the app schema; mint the runtime's
   group token and the backup job's read-only group token.
2. Read Rem's `account_id` with one `GET /v1/me` on the stored production token. If the response has
   no `account_id`, stop: the design keys on it (§10.2), and this is the moment to find out.
3. Insert users row 1: that `account_id`, `spotify_id` = `SPOTIFY_OWNER_ID`, `db_name = 'lazyboy'`,
   its URL, `status = 'active'`, `is_admin = 1`, `session_epoch = 0`. Phase 1's cookies say `uid: 1`,
   `ep: 0`, so Rem stays signed in.
4. In `lazyboy`, write `owner_uid = 1` and `schema_version`: the only writes this migration makes to
   Rem's data database.
5. Pause the pingers and wait for quiet (STORE_MIGRATION §8 steps 2-3). Encrypt the token row for
   uid 1 into `user_tokens`; `granted_at` = now minus 30 days (every session is at most 30 days old
   and every sign-in re-authorizes, 01e §5.7), corrected at Rem's next sign-in.
6. Deploy phase 2. Compare the two token copies on `expiresAt` and keep the later (an old instance
   may have refreshed in between). Pingers on; three ticks answer 200 with uid 1's outcome `ok`.
7. Verify: the seven tables' row counts equal the pre-migration counts; `verify-derived.mjs --user 1`
   green; the `meta` key set equal less the moved and dropped keys; Rem still signed in; the
   recorder diff over the pause empty (STORE_MIGRATION §8 step 13's check). This is T12 run for
   real.
8. A week later, delete `spotify_tokens` from `lazyboy`'s `meta`.

**Rollback.** Before step 8: redeploy phase 1, which reads the plaintext row; if a refresh happened
since, the access token has expired and the unchanged refresh token renews it. After step 8: a
script decrypts uid 1's blob back into `meta.spotify_tokens`, then redeploy. Nothing else in Rem's
database changed, so nothing else needs undoing.

## 10. Sign-up gating

### 10.1 Invites and provisioning

Invites are made by Rem, on the Mac, with `scripts/invite.mjs --spotify-id <id>`:

1. Refuse if active plus invited users already number `MAX_USERS` (5; `--force` to override, for a
   grandfathered allowlist).
2. Insert the users row in status `provisioning`, which reserves the uid; create
   `lb-u-<random>` in group `default` with the Turso CLI on the Mac; apply the user schema; write `owner_uid` = that uid and `schema_version`; set the row to `invited`
   with `spotify_id`, `db_name`, `db_url` and `invited_at`. A crash leaves a `provisioning` row the
   script resumes or removes.
3. Print the join link. Rem also adds the person to the app's User Management list in Spotify's
   dashboard (name and e-mail; up to five, 01f §1.2): Spotify's gate and the app's are both needed,
   since the app cannot see the dashboard and the dashboard cannot disable someone in the app
   (01e §5.4).

Provisioning stays a script because it is rare (four times, ever, at five users) and keeps
database creation out of the deployed code.

### 10.2 Sign-in and the claim

- **`/join`** (no session needed) shows the privacy policy and the end-user agreement, which the
  Developer Terms require before sign-up (§V, quoted in 01f §1.5). "I agree" sets a short-lived
  signed cookie naming the terms version; then "Connect Spotify".
- **The signIn callback** gets the profile from `/v1/me` (`cache: "no-store"`, §2.5) and decides:
  1. a 403 "not registered" goes to `/login?error=SpotifyNotRegistered`, as today
     (`src/lib/auth.ts:345`);
  2. no `account_id` in the profile: refused and logged (01e §5.5), never a fallback to `id`;
  3. `userByAccount(account_id)` finds a returning user: `active` or `needs_reconnect` signs in (and
     `spotify_id` is refreshed if it changed); `disabled`, `deleting` or `deleted` is refused;
  4. otherwise a claim, which needs the terms cookie:
     ```sql
     UPDATE users SET account_id = :aid, status = 'active', claimed_at = :now,
            terms_version = :tv, terms_accepted_at = :now
     WHERE status = 'invited' AND spotify_id = :sid AND account_id IS NULL
     RETURNING id
     ```
     One row back signs in as that uid; none is AccessDenied ("this app is invite-only").
- **The jwt callback's sign-in pass** writes the token row for that uid and puts `uid` and `ep` on
  the cookie (§4.2).

An invite matches on Spotify's `id` once, because that is what Rem can see before the person signs
in; from the claim on, the user is found by `account_id`, so a later change of `id` changes nothing
(01e §5.4-5.5). `src/lib/owner.ts` goes in phase 4, after everything it guards against is gone
(01c S18).

## 11. Privacy

- **Who sees what.** Each user sees only their own data. This design has no cross-user feature.
  When friends features come (ROADMAP), the one sanctioned way to read another user's data would be
  a single function, `forFriend(viewer, owner)`, that checks a consent table and opens the owner's
  database read-only, so a cross-user read is one call a reviewer can find, never a side effect. It
  is a sketch for later, not part of this build.
- **The operator.** Rem holds the credentials and can technically read any user's database. The
  privacy policy says so. The admin views show operational state per user (status, last success,
  failures, quota spend, store usage per database) and telemetry without song names; there is no
  admin view of anyone's listening.
- **Asking for less.** The app requests 13 scopes (`src/lib/auth.ts:32-46`). `user-read-email` goes
  (development mode returns no e-mail anyway, 01e §1.1). `user-read-private` goes too, once a test
  sign-in confirms `/v1/me` still returns `account_id` without it; I did not find that documented
  either way.
- **Telemetry** holds a uid, endpoint paths and timings, no song names (§2.7), 30 days, deleted with
  the account.
- **Retention.** Rem's own history: kept indefinitely, it is his record. Friends': kept while they
  are connected, deleted within five days of a disconnect (§12), and deleted after twelve months
  without a sign-in, so the store does not hold anyone's history "indefinitely" (Developer Terms §IV,
  01f §1.5). The twelve months is my suggestion and Rem's call (§16).
- **Backups** are one file per database (§8.3 item 3), kept on today's schedule (14 days on the
  Zenbook, 60 on OneDrive) while the person is a user, and deleted with the account (§12).
- **Vendors** the policy has to name, since the Terms make the app responsible for its providers'
  security (01f §1.5): Vercel, Turso, Tailscale and the Zenbook (telemetry, backup staging),
  OneDrive (offsite backups), cron-job.org (sees the cron secret and count-only responses).
- **Derived listening metrics** (listened time, skip verdicts, all-time stats) sit against the
  Developer Policy's line on "derived listenership metrics" (01f §1.5). In this design they are shown
  only to the person they describe. Whether to show them at all to friends is Rem's call.
- **Breach duty**: suspected breaches go to Spotify within 24 hours (Data Protection Appendix §9,
  01f §1.5). The isolation events of §5.4 are the in-app tripwire most likely to surface one.
- **No e-mail.** Development mode returns no address and the policy forbids unsolicited mail (01f
  §1.5), so every notice (a dead grant, a pending deletion) appears in the app.

The policy and the end-user agreement are Rem's to write or approve. They need at least: what is
collected (Spotify account and profile ids, display name, encrypted tokens, listening history,
library, the stats derived from them), where it is stored and by whom, retention, how to disconnect
and delete, the operator's access, and the minimum terms the Developer Terms list for an end-user
agreement (disclaimers, Spotify as third-party beneficiary; 01f §1.5).

## 12. Account deletion

Three ways in: the user's "Disconnect and delete" (the mechanism the Developer Policy requires, 01e
§5.8); an `invalid_grant` that arrives within six months of the grant, which 01e §5.7 recommends
treating as a disconnect (Rem's call, §16); and an admin removal. All three run one idempotent job;
each step can be re-run and the job resumes from the user's status:

1. `status = 'deleting'`, `session_epoch + 1`, `deletion_requested_at = now`: every session of the
   user fails on its next request. The `sync_state` row is deleted, so the cron stops.
2. The token row is deleted; any `lock:*:<uid>` rows go with it.
3. The user's Data Cache entries are purged by their tag (`revalidateTag("u:<uid>")`, §2.4).
4. Telemetry rows with that `user_id` are deleted.
5. The user's database is destroyed through Turso's platform API, after two checks: the database
   is the one named in the user's row, and its `owner_uid` is the departing uid. The job refuses
   uid 1 and any admin outright.
6. The nightly backup job removes the user's backup files, on the Zenbook and on OneDrive, when it
   sees status `deleting` or `deleted`.
7. Five days later, when Turso's recovery window has closed, the daily route turns the row into a
   tombstone: `account_id` and `spotify_id` cleared, `status = 'deleted'`, `deleted_at` set. The
   uid is never reused (§3.1). Until then a returning sign-in finds the row in `deleting` and is
   told the account is being deleted; Rem can undo it inside the window with a restore script on
   the Mac (Turso's restore of the database, the row back to `active`; the person then signs in
   again for a fresh token).

The response to the request that starts it sends `Clear-Site-Data`, and the page tells the person to
remove Lazy Boy at spotify.com/account/apps, since the app cannot revoke a grant itself (01e §5.8).

**The five-day clock and Turso.** Spotify's terms say delete within five days (01f §1.5). Destroying
the database is what meets it on a paid plan: a destroyed database stays recoverable for "up to five
days after deletion" and point-in-time recovery cannot bring it back, whereas rows deleted inside a
living database remain restorable for 10 days on Developer (§2.1). So step 5 runs the same day,
inside the request's `after()` or the next cron tick, and Turso's five days then run alongside
Spotify's five.

That same window settles the ambiguous case. 01e §5.7 worries that purging on an `invalid_grant`
is irreversible if the person only revoked by mistake, and that waiting is outside the Terms. On a
paid plan the job can destroy at once for every trigger: if the person signs in again within five
days, Rem restores their database from Turso's recovery and nothing is lost; after five days it is
gone for good, inside the Terms. On the free plan there is no recovery of deleted databases and
point-in-time recovery holds 24 hours, so an immediate destroy is final; there the ambiguous case
would need a grace of up to four days before step 5, and the explicit disconnect none. Turning off
Turso's "Allow restore" toggle would end the recoverable window at once, at the price of this grace
and of Rem's own safety net against a mistaken delete; I would leave it on.

**Where the platform token lives.** Step 5 needs `TURSO_PLATFORM_TOKEN`, and 01e §6 recommends
taking it out of the runtime once a second user exists. I recommend keeping it, Production only, for
two functions only: this destroy, and the daily usage read STORE_MIGRATION's daily route already
plans (its §6 item 7). The runtime already holds a group token that reads and writes every user's
database, so the platform token adds destructive power, not access, and the destroy is guarded by
the owner check and, on a paid plan, recoverable for five days. Moving the destroy to a script on
the Mac would put the five-day clock in the hands of a laptop that is not always on. Rem's call
(§16).

## 13. Meeting each target, step by step

Every figure is labelled. "Rem-like" means Rem's measured profile (~115 real plays a day, 01a §6;
129 on Oct 14, 01c §2); "light" means 40 plays a day and ~4 hours of playback, an assumption
(01f §5.1 uses the same). Turso round trips use STORE_MIGRATION's R1 target (p50 ≤ 15 ms), which
lane 1902/1903 will measure; if R1 misses, every "store" line below grows by the difference per
serial round trip.

### 13.1 Users (U)

| resource | per Rem-like user a day | five Rem-like | Rem + 4 light | limit | source |
|---|---|---|---|---|---|
| allowlist places | 1 | 5 | 5 | 5 | 01f §1.2 |
| recently-played calls | ~140, plus the recorder's 24 for Rem | held near 450-505 by §6.4 | ~430 | ~725-800 observed; plan 450 | 01c §5.1; §13.3 |
| player calls | ~450 after 01c §5.1's changes | ~2,250 | ~2,250 | unmeasured | 01c §5.1 |
| Turso rows read | ~0.8M (§13.4) | ~120M a month | less | 500M (R4: 250M) | §13.4 |
| Turso rows written | ~4,000 (§13.4) | ~0.6M a month | less | 10M (R4: 1M) | §13.4 |
| Turso databases | 1 | 6 with the app's | 6 | 100 (Free) | §2.1 |
| Vercel invocations | ~200 browsing; the cron is 1,440 a day in total, flat in N | ~73,000 a month | less | 1,000,000 (Hobby) | 01f §2.3; §6.8 |
| Vercel Active CPU | 0.5-2.4 CPU-hours a month for Rem today, unmeasured | 2.5-12 | less | 4 (Hobby, team-wide) | 01f §2.3-2.4 |

Five accounts fit every budget but one unknown: Vercel's Active CPU, which no API open to Hobby
reports (01f §2.3) and which, overrun, stops every project on the team for up to 30 days. Rem can read
it on the dashboard in a minute (§16). Above five, reachable only with a grandfathered list, the
order things bind is: Active CPU (if the users are Rem-like), then closed-app freshness (each user's
share of 450 shrinks as 450 ÷ N), then Turso Free's reads under R4 at about ten Rem-like users. The
first structural limit is Turso Free's 100 databases.

### 13.2 Search (S1-S3)

**S1, a repeat visit, 4× CPU** (Rem's data today):

| step | budget | basis |
|---|---|---|
| read the stored segments and library from IndexedDB | 20 ms | measured 18-20 ms at 4× for today's two bodies (01d O5) |
| check each body's `u` against the page's `hk` | < 1 ms | a string compare per body |
| build the search set | 47 ms | measured 46.6 ms at 4× (01d §2.3) |
| build the selected day | ~5 ms | estimate, lazy days (~100 rows, 01d O6) |
| **search usable** | **~75 ms of 300** | |
| after paint: manifest and delta | ~150-250 ms, off the critical path | estimate: one request, the gate and two store round trips |

A heavy one-year user's set is about 1.45× Rem's (~21,000 entries against 14,507 [estimate from
01d §3.3's profile]), which puts the build near 70 ms and the IndexedDB read near 30 ms: still well
under 300.

**S2, a first visit, typical one-year user, 4× CPU, 10 Mbit/s:**

| step | budget | basis |
|---|---|---|
| the idle callback after first paint | ≤ 300 ms | estimate: it waits for hydration on a phone; its timeout is 2 s (`den-home.tsx:595-641`) |
| the manifest | ~150 ms | estimate: the gate's app-database read and one user-database read at 15 ms each, plus ~100 ms of mobile round trip and function time |
| library (~350 KB gzipped) and history segments (~350 KB) in parallel, server side | 50-300 ms | a Data Cache hit, or one month rebuilt from an index range (~4,500 rows) [estimate] |
| transfer of ~700 KB at 10 Mbit/s | ~560 ms | arithmetic (01d §5.2) |
| parse and build the search set | ~50 ms | 01d §5.2 |
| build the selected day | ~5 ms | lazy days |
| **search usable** | **~1.1-1.4 s of 2 s** | |

Isolation's share of S2: each request runs the gate (one app-database round trip, ~15 ms, in
parallel across the segment requests) and microsecond checks. On slow 4G (1.6 Mbit/s) the transfer
alone is ~3.5 s, a miss (§13.6).

**S3, a keystroke, 4× CPU:**

| step | budget | basis |
|---|---|---|
| fold, match, rank and cap at 400 | 10.5-13.2 ms at Rem's size; ~15-19 ms for a heavy user | measured for one-letter queries (01d §2.3); the heavy figure scales 01d §3.2's 25.6 ms at 2× size down to ~1.45× |
| paint the first screenful (~30 rows), the rest on scroll | ≤ 25 ms | estimate; rendering on a phone is unmeasured (01d §8) |
| **filtered rows painted** | **~35-45 ms of 50** | |

Today's render paints up to 400 complete rows per keystroke, which 01d §2.3 found is most of the
desktop's 18-44 ms keystroke-to-paint; at 4× it plausibly misses 50 ms, which is why phase 0 measures
it with `lb-perf` before anything else changes. Isolation costs S3 nothing: a keystroke never leaves
the browser.

### 13.3 Freshness (F)

**App visible.** The browser shows the play at the end-of-track poll, ~1 s (today's handoff, 01c
§5.3). The visible tab's `/api/sync` runs the user's step on its next poll, every 2 minutes
(`src/components/sync-on-load.tsx:12-27`), and a harvest with its writes takes ~1-3 s (01c §2.1, at
R1). In the store within 2 minutes.

**App closed.** The cron probes an active user every 2 minutes (every minute while both pingers run,
§6.7) and harvests on the track change in the same tick: in the store within ~2 minutes, while §6.4
keeps the user on track-change harvests. Opening the app runs an on-load harvest, so what a person
sees on opening is current within seconds whatever mode they are in.

**The scarce budget, per quota day** [estimate, from 01c §5.1's per-policy figures]:

| users | Rem | each friend | recorder | on-load harvests | track-change total | what §6.4 does | closed-app freshness |
|---|---|---|---|---|---|---|---|
| Rem + 4 light | ~140 | ~60 | 24 | ~25 | ~430 | the app passes 338 (¾ of 450) about 80% into the day; Rem is above his share of 90 by then and moves to 15-minute batches | 2 minutes for everyone, Rem for ~80% of his listening day and ≤ 15 minutes after |
| 5 Rem-like | ~140 | ~140 | 24 | ~25 | ~750 | nobody is above 90 at 338; the app reaches 450 about 60% into the day and everyone moves to 30-minute batches | 2 minutes for ~60% of the listening day, then ≤ 30 minutes; total spend ~505, ~65% of the observed ban line |
| any mix, quota per user | – | – | – | – | – | nothing | 2 minutes all day |

Completeness holds in every row: a harvest comes at least every 40 track changes and every two hours
while idle, so the 50-play window never overflows (§6.4). Target F is met for Rem and light friends,
and for five heavy listeners only while the app is open or for the first ~60% of the day (§13.6).

### 13.4 Store reads and growth (D)

Reads for one Rem-like user on a heavy day: today, measured by the meter on Oct 14 (01c §2.2,
§2.7, §5.9), against this design with 01c's levers in place.

| read | today | this design | how |
|---|---|---|---|
| all-time recompute (`orderedRealPlays`, `db.ts:854-869`) | 2,244,004 (44 runs × ~51,000) | ~0.01M | an accumulator adding each new play's listened time, re-deriving only around an out-of-order insert (01c §5.9; READ_QUOTA's "queued lever") [estimate] |
| Home payload: 16-day strip (`readDailyStats`) | 715,850 (127 × ~5,600) | ~0.01M | the strip updated in place on an append (01c §5.9) [estimate] |
| Home payload: opening day | 238,415 | 0.24M | unchanged; bounded by one day's plays |
| new plays' orphan and skip verdicts | ~17,500 | ~0.02M | unchanged |
| harvest probes | ~0.06M | 0.06M | unchanged |
| unique-song count | ~0.16M | 0.16M | unchanged; runs only when the library changes |
| unscoped orphan pass | ~5M per run on Turso's terms, ~3 a week: ~2.2M a day averaged | ~0.22M | scoped to changed playlists (lanes 1910-1911), taken as ~10× cheaper (01c §5.9) |
| search | 0-2 full rebuilds a day (~80,000 rows each) | ~0.07M | segments: one month (~4,500) and the library (~8,800, half the visits) per visit, 8 visits [estimate, 01d §4.2] |
| identity, tokens, queue, owner checks | ~1 token read per request | ~1 read per request, ~1 claim per tick | §2.9 |
| **a heavy day** | **~4.5-5.6M** | **~0.8M** | target ≤ 1.5M: met |

Five Rem-like users: ~0.8M × 5 × 30 ≈ 120M rows a month, 24% of Turso Free and inside R4's 50%
[estimate]. Without the accumulator and the in-place strip, a user costs ~3.75M a day and five cost
~560M a month, over the free plan; on Developer ($4.99 a month, 2.5B included) that still fits with
no overage (§15). So the two levers decide the plan, not whether five users work.

**No read grows with total history on a per-play or per-tick path** once the accumulator replaces
the recompute: segments are bounded by a month, the opening day by a day, the orphan pass by the
changed playlists, the unique-song count by the library. Two once-a-day passes still scan a user's
plays (`unresolvedContextUris`, `db.ts:646`, and the daily heal); once a day they are cheap.

**Writes**, per Rem-like user a day [estimate]: ~3,000 core rows (01c §2.7), ~72 token-related rows
(01e §5.2), and ~900 queue rows (a claim and a release per probe: ~270 probes while active, ~180
while idle), ~4,000 in all; target ≤ 5,000 met. Five users: ~0.6M a month, 6% of 10M, inside R4's
10%. **Growth**: ~35 KB of core data a user a day (01a §6), ~64 MB a year at five users against
Free's 5 GB. Telemetry stays on the Zenbook, pruned at 30 days once the daily route runs, ~7 MB per
user (01a §9.1).

### 13.5 Uptime (A)

| failure | user requests | closed-app capture | plays lost |
|---|---|---|---|
| Zenbook down or rebooting (~3 AM daily, 6-8 min, 01f §3.3) | unaffected (R2); telemetry writes fail off the user path; `/usage` shows its log sections empty | the off-Zenbook pinger keeps every user ticking every 2 min | none |
| Zenbook frozen (stalls, 01f §3.3) | unaffected; an already failed request's error beacon waits at most 4 s (STORE_MIGRATION §6 item 4) | as above | none |
| Funnel certificate expires (Nov 8) | telemetry only, after the move; lane 1907 renews it | unaffected | none |
| cron-job.org down | none | the Zenbook's pinger | none |
| both pingers down | none | only the daily Vercel cron (07:00 UTC ± 59 min) | each user's plays beyond their newest 50, ~2.5-3.5 hours of nonstop listening (01c §5.7); Rem's recorder covers him unless the Zenbook is the one down |
| one user's grant revoked, de-allowlisted, or their database refused | that user only | that user only (§6.5) | that user's, beyond 50, until they reconnect |
| Turso, Vercel or Spotify down; Rem's Premium lapses; the app is disabled | everyone | everyone | the 50-play rule, everyone |
| Turso Free's quota exceeded | everyone, until the 1st | everyone | the same; Developer with overages turns this into a bill (§15) |
| Spotify quota ban (`QUOTA_EXCEEDED`) | Spotify actions in that bucket, everyone | paused to the ~10:50 AM reset | the 50-play rule; §6.4 makes it unlikely |

A1-A3 hold: no row but the shared ones touches a user path or another user. The shared ones are A4's
list, named and each with its owner in §16.

### 13.6 Targets the design does not meet, and the options

1. **U above five on one Spotify app.** Not possible under Spotify's policy (01f §1.3). Options:
   (a) each extra person runs their own copy (01f option E): $0 hosting each, but their own Premium,
   their own Spotify app and about an hour of setup with Rem's help; this design's code runs as a
   one-user copy unchanged. (b) A grandfathered allowlist, if the dashboard shows one: the design
   scales to it within §13.1's limits. (c) Extended quota: closed to individuals.
2. **F with the app closed, for five heavy listeners, if the quota is shared.** Met for ~60% of each
   listening day, then within 30 minutes. Options: (a) accept it, at no cost, since opening the app
   is always current within seconds; (b) server-side provisional plays from the player probe (01c
   §5.3 (ii)), 2 minutes for everyone, at medium-to-large cost: a provisional flag through the skip
   chain, the totals and both payloads, a reconciliation and its tests; (c) the passive check of
   01c §7.3, which may show the quota is per user and make the question moot.
3. **S2 on slow 4G.** ~3.5 s of transfer for a typical user's first visit. Options: one dictionary
   of art URLs and album names per user shared across segments, which recovers some of the ~30% the
   segments add to a cold visit (01d O3); or accept a slow first visit on a slow network. A light
   user (~250 KB) fits either way.
4. **S3 if the first-screenful render is not enough** on a real phone: matching in a Web Worker (01d
   O6). Unknown until measured.

## 14. Rollout in reversible phases

Each phase ships behind the previous one's exit check. Until phase 4 nobody but Rem can sign in,
because the owner guard (`src/lib/owner.ts`) stays in place, so phases 1-3 change how the app is
built, never who can reach it.

| phase | what ships | exit check | how it is undone |
|---|---|---|---|
| **0, now** (no multi-user code) | rotate `AUTH_SECRET`, Preview gets its own (01b E1, 01e F1); set `SPOTIFY_OWNER_ID` in Production and `.env.local` (01b E2); gate `logout` (01b E3); STORE_MIGRATION with §8.3's six edits; lazy days and history segments before December (§7.4); measure S3's render at 4× (§13.2); read Vercel's Active CPU and the allowlist (§16); the foreign-row cleanup after lane 1904 (§9.2) | Rem signed in on the new secret; STORE_MIGRATION's own R1-R6; the cleanup's `verify-derived` green | env changes and deploys revert; the cleanup restores from its snapshot |
| **1, identity and isolation scaffolding** (single-user) | `UserId` and the gate on every entry point; `uid: 1`, `ep: 0` on the cookie for the owner, cookies without a uid refused (Rem signs in once, which is F1's lasting fix); `forUser(1)` over today's one database (the uid-to-database map and the epoch are constants until phase 2), `owner_uid = 1` written; `userCache` with owner stamps; keyed React boxes and module state; `playlistsCache` removed; task owners; `hk` in ETags, URLs, bodies and storage; the token core out of `auth.ts`, with its in-flight map keyed and tokens carrying their owner; tests T1-T3, T7, T8 and S1-S6 green with a simulated uid 2 | the suite green; a week of production with zero isolation events and capture unchanged (play counts against the recorder) | revert the deploy: old code ignores the extra cookie claim and the two new `meta` keys |
| **2, the app database and the tokens** (single-user) | `lazyboy-app`; users row 1; the token encrypted into `user_tokens`; the jwt callback's one join (§4.2); the steps of §9.3; test T5 | §9.3 step 7 | §9.3's rollback |
| **3, the sync queue** (single-user) | `sync_state` with claims and leases; the per-user step; cooldowns per bucket; the fair-share counters (inert at one user); `/api/sync` through the step; `refreshHistoryAction` off Spotify; now-playing at 15 s; the rescan changes; then the second pinger; the recorder hourly; tests T4, T6 | a week of capture matching the recorder, no harvest doubled by two pingers | revert the route code; disable the second pinger |
| **4, the first friend** | the invite script, `/join` with the policy and agreement, the claim (§10); disconnect and deletion (§12); one backup file per database; admin-only `/usage`; `owner.ts` removed; Preview without store variables and dev on local files, both confirmed; the Turso plan decided (§16) before the friend's first sync; tests T9-T11; an adversarial review of the whole change | a week with one friend: isolation events at zero, the friend's quota spend visible per user (`api_log.user_id`), no ban | set the friend `disabled` (their sessions die and their sync stops at once); if they leave, the deletion job |
| **5, up to five** | one friend at a time | each after a week without a quota ban and with isolation events at zero, read against 01c §7.3's passive quota check | per user, as phase 4 |

The irreversible steps, all named where they happen: deleting the incident's foreign plays (§9.2,
snapshot first, Rem's yes on the list), deleting the plaintext token row a week into phase 2 (§9.3
step 8, still recoverable by decrypting), and a friend's account deletion once Turso's recovery
window has passed (§12), which is irreversible by design.

## 15. Costs

**Money, a month, at five users** (01f §5.3's prices, checked against the pricing page at 10:11 PM):

| item | cost | note |
|---|---|---|
| Turso | $0 on Free if the accumulator and the in-place strip ship (§13.4); **$4.99 billed yearly ($5.99 monthly)** on Developer with overages enabled | five Rem-like users fit Free only with the two levers (~120M against 500M) and fit Developer's 2.5B included reads without them. Crossing Free's quota blocks every query for every user until the 1st (01f §4.2) |
| Vercel | $0 on Hobby if the team's Active CPU fits; $20 on Pro otherwise | unmeasured; overrunning Hobby stops every project on the team for up to 30 days (01f §2.2) |
| cron-job.org (second pinger) | $0 | phase 3 |
| the Zenbook | $0 | power is not metered (01f §5.2) |
| Spotify | $0 | friends cannot be charged: the app controls playback, which makes it a Streaming SDA, and the policy allows such apps no commercial use (01f §1.5) |
| **total** | **$0-26** | the same range as 01f §5.3 |

**What isolation adds to that: $0.** The per-user databases are free (100 on Free, unlimited on
paid, idle ones cost only storage, §2.1); encryption is Node's built-in `crypto`; the tests run in
the existing harness. Every dollar above is a plan choice any multi-user design faces.

**Work**, as relative sizes rather than hours (S one place, M a contract with callers to follow, L a
design change), so the director can turn them into lanes:

| phase | size | the big pieces |
|---|---|---|
| 1 | L | `db.ts`'s 74 exports behind `forUser`, with every caller touched once (01a D2); the gate on 8 pages, 24 actions and 12 routes (01b §2); `userCache`; the test harness, T1-T3, T7, T8 and S1-S6 |
| 2 | M | `app-db.ts`, the token rows encrypted, the migration script, T5 |
| 3 | M-L | 01c §5's queue, step and policies |
| 4 | M | invite, join and claim; deletion; the backup loop; admin gating |

Against a shared-database design the work is of a similar size but lands in different places: a
row-level design rewrites more than fifty statements and their indexes, rebuilds four tables in a
migration over live data (01a §8.6), and needs no client map, app database or provisioning script.
This design changes no statement in the seven tables and adds the plumbing. The difference that
decides it is §2.1's: where a mistake lands when one is made.

## 16. Decisions that are Rem's

Each with my recommendation and the reason.

**Now, whether or not anyone else ever signs in**

1. **Rotate `AUTH_SECRET`, set `SPOTIFY_OWNER_ID` in Production, and gate `logout`.** Yes, before
   STORE_MIGRATION's freeze: a browser that signed in before the guard can still act as you until
   about Nov 13, and its log-out can stop your capture (01b E1-E3, 01e F1). One sign-in.
2. **STORE_MIGRATION's six edits (§8.3).** Make them before lane 1901 starts; none touches the
   cutover, and each saves doing the same work twice later.
3. **Delete the incident's foreign plays from your history** after reading the list (§9.2). Yes:
   they are someone else's listening inside your stats.
4. **Two one-minute dashboard reads**: Spotify's User Management list (how many accounts, any
   grandfathered above five, whether you count toward the five) and Vercel's Active CPU per project
   over 30 days. They settle target U and the Vercel plan (01f §6.2).

**The design**

5. **Five accounts, not 25.** Yes: Spotify's cap, which no money changes (01f §1.2-1.3). More people
   run their own copies (§13.6).
6. **One database per user.** Yes: a forgotten filter is impossible rather than unlikely, deletion
   reaches Turso's recovery window cleanly, and your data does not move (§2.1, §9). Revisit only if
   cross-user features become the priority.
7. **Closed-app freshness if the quota is shared**: accept §6.4's fair share (2 minutes until the
   day's budget runs low, then 15-30 minutes, opening the app always current) rather than build
   server-side provisional plays now. Revisit after the passive quota check (01c §7.3).

**Before the first friend**

8. **Turso Developer with overages, $4.99 a month billed yearly.** Yes: crossing Free's quota is an
   outage for everyone until the 1st, and the levers that keep five users on Free should not be
   tested by that outage.
9. **Vercel**: Hobby if the team uses under ~2 of its 4 CPU-hours, else Pro at $20 (01f §6.3).
10. **What "log out" means.** Split it into sign out, sign out everywhere, and disconnect and delete
    (01e §5.6): with friends, signing out of a shared computer should not stop someone's history.
11. **`invalid_grant` within six months of a grant**: treat it as a disconnect and destroy at once,
    you exempt (01e §5.7). On a paid plan Turso's five-day recovery is the grace: a person who comes
    back inside it is restored (§12). The alternative keeps data on an ambiguous signal, outside the
    Terms.
12. **Retention for friends**: kept while connected, deleted five days after a disconnect, deleted
    after twelve months without a sign-in (§11). The twelve months is the number to choose.
13. **Backups**: one file per database, a friend's deleted with their account (§8.3, §12). Yes.
14. **The platform token stays in the runtime** for same-day database destruction and the daily
    usage read, Production only (§12). The alternative, a Mac script, puts the five-day deletion
    clock on a laptop that is not always on.
15. **Turso's "Allow restore" stays on**: a mistaken delete, or a person who revoked by accident, is
    recoverable for five days, which still fits inside Spotify's five when the destroy runs the same
    day (§12).
16. **The privacy policy and end-user agreement**: yours to write or approve; §11 lists what they
    must say. And whether friends see derived stats (listened time, skips) at all, given the
    Developer Policy's line on derived listenership metrics (01f §1.5); this design shows each
    person only their own.

**Smaller**

17. **The recorder stays yours alone and runs hourly** (01c §5.7, 01e §5.9). Yes.
18. **A second pinger on cron-job.org** in phase 3. Yes; free, and it ends the Zenbook as the only
    capture trigger (§6.7).
19. **A canary account in phase 4**, only if you have a spare Spotify account: it holds one of the
    five places while it exists (§5.4).
20. **Friends' history imports** wait for segments (01d §7.2): a five-year import is a ~4.2 MB body
    today.

## 17. What I ran, and what I do not know

### 17.1 What I ran

Nothing ran against the production store, the Zenbook, any Turso database, Vercel or Spotify.

- **Repo reads**: the six overviews in full, `docs/STORE_MIGRATION.md`, `docs/SECURITY.md`,
  `docs/GOTCHAS.md`, and the code cited above. `git diff --stat ac6f7fe HEAD -- src scripts ops tests
  vercel.json next.config.ts` (empty, so the overviews' line numbers hold); `git show --stat 044c9b6`
  and `git log` over Oct 14 for the incident's commits.
- **Turso's pages**, 10:11-10:13 PM, `curl -sSL` with a desktop user agent into a scratch
  directory, then a one-off Python pass that stripped the HTML and printed the passages quoted in
  §2.1 and §12: `docs.turso.tech/cli/group/tokens/create`, `/cli/db/tokens/create`,
  `/features/multi-db-schemas`, `/api-reference/databases/create`,
  `/features/point-in-time-recovery`, `/features/recover-deleted-databases`,
  `/api-reference/databases/delete`, and `turso.tech/pricing`. All answered 200.
- **A crypto micro-benchmark** (`~/.claude/broke/scratch/lazyboy_mu/0222_design_a/bin/crypto_bench.mjs`,
  Node 24.5.0 on the Mac, arm64, synthetic token strings, 7 runs of 20,000-50,000 operations,
  medians): AES-256-GCM encrypt 2.67 µs (2.61-2.93), decrypt 1.67 µs (1.62-2.34) for a 450-byte
  blob; HMAC-SHA256 0.86 µs (0.85-0.91). The same script checks that a ciphertext decrypted under
  another uid's associated data is refused: it was.

### 17.2 What I do not know

- **Whether Spotify's development-mode quota is one pool or per user** (01c §4). §6.4 is built for
  the pool and relaxes if it is per user.
- **Whether `/v1/me` returns `account_id` to this app**: documented, not observed (01e §8). Phase 2's
  step 2 finds out before anything depends on it; whether `user-read-private` is needed for it is
  not documented either (§11).
- **Vercel's Active CPU** for this team, and **the allowlist's size**, both dashboard reads (§16).
- **R1 on Turso**: every store time here uses its 15 ms target; lanes 1902-1903 measure it.
- **Keystroke render time on a phone** (§13.2): unmeasured anywhere; phase 0 measures it.
- **Whether Preview and Production share the Data Cache, and whether React's `cache()` is active in
  route handlers** (01b §8): the owner stamp and the keyed boxes make the design correct either way.
- **Next 16's `revalidateTag` signature** and **the fields of Turso's per-database usage endpoint**:
  to check at implementation; I read the endpoint's existence from the docs' navigation only.
- **What "Turso is joining Supabase" means** for plans and prices (§8.1).
- **The incident's exact window**: the recorder diff of §9.2 finds the rows without it.
- **The time the isolation suite adds to `npm test`**: this checkout has no `node_modules`.
