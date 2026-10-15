# Security review of the multi-user plan

Lane 0224_lb_mu_review_security, Oct 14-15, 2026. An adversarial review of `PLAN.md` in a fresh context,
one lens only: any path by which one user could read or change another's data, weak token handling,
and what the isolation design misses. Planning only: no code, data, store, Turso or Vercel setting was
changed. Code line numbers are against `ac6f7fe`, as the plan's are (`git diff --stat ac6f7fe HEAD --
src scripts ops tests vercel.json next.config.ts package.json` is still empty). §5 lists what I ran.

Status: complete, Oct 15, 2026.

## 0. Summary

The isolation skeleton holds: a database per user with an owner stamp, a branded uid only three
functions mint, keyed token state with AES-GCM bound to the uid, and the gate before every read. I
could not find a cross-user read in the target design as written. The holes are at its edges, where
the plan assumes an operation does what its name says:

- **R1 (High).** A Vercel deployment keeps the environment it was built with, and Instant Rollback
  restores that environment. After Phase 0, a one-click rollback brings back the old `AUTH_SECRET` and
  with it the incident's session as Rem; on Pro, a rollback across Phase 1 puts single-user code in
  front of friends' valid cookies, and its search routes serve Rem's history to them. Fix: rotate
  `AUTH_SECRET` again at Phase 1 (it costs nothing, since Phase 1 makes Rem sign in once anyway),
  delete pre-rotation and pre-Phase-1 production deployments, rebuild instead of rolling back.
- **R2.** `status = 'disabled'`, the plan's kill switch, ends sessions but not sync: the cron's claim
  never reads `users.status`.
- **R3.** A refresh racing the deletion job writes the deleted user's live grant back, and nothing
  sweeps it.
- **R4.** One `invalid_grant` storm would destroy every friend's database at once (no correlated-failure
  guard, no undelete on Free), and a refresh racing a sign-in can make an expiry read as a revocation.
- **R5.** Sessions renew through `GET /api/auth/session`, so "fixed 30 days" is not a bound and the
  pre-guard browser does not expire on Nov 13; add an `auth_time` claim.
- R6-R10, medium-low: the identity check's failure mode is unspecified and today's code fails open;
  the isolation tripwire is forgeable through `/api/metrics` and lost when the Zenbook is down; the
  platform token in `.env.local`; the production token key handled on the Mac; the Funnel-facing
  Zenbook holding every friend's read credential. R11-R16 are hardening and process.

STORE_MIGRATION needs no hold. Its edits 2, 4 and 5 close live exposures; add Phase 0 before lane
1903's flip, and name the `lazyboy` token Phase 2 must invalidate (§3).

## 1. Findings, most severe first

Severity is impact times likelihood at five users: **High** opens a cross-user read or reinstates a
retired credential through a step the plan itself invites; **Medium** breaks one of the plan's stated
guarantees (a kill switch, deletion, revocation) in a reachable case; **Low** is hardening or a gap in
detection. Every finding names the plan section it corrects and a fix sized to it.

### R1 (High). Old deployments keep the secrets and code they were built with, and a rollback brings them back

The plan's revocation tools are a redeploy with a new value: `AUTH_SECRET` rotation is "the
everyone-out switch" (§5.4) and Phase 0's fix for the pre-guard browser; a `TOKEN_KEYS` rotation is
how §12.3 makes the vendor's copy of a deleted friend's token unreadable; `SIGNUPS=owner` is Phase
4's way back. Each assumes the old deployment stops mattering. It does not:

- Vercel's Instant Rollback "won't update environment variables if you change them in the project
  settings and will roll back to a previous build"; its confirmation screen says environment
  variables "will remain in their original state". Hobby can roll back to the immediately previous
  deployment; Pro and Enterprise to any deployment that was ever production
  (https://vercel.com/docs/instant-rollback, fetched Oct 15).
- This project keeps production deployments 30 days and always the last 10
  (`deploymentExpiration`, `vercel api /v9/projects/lazy-boy`, read Oct 15).
- The plan's rollback column says "redeploy the previous build" (§13.1, Phase 1), "redeploy Phase 1"
  (§11.4) and "redeploy" (P2, P4); one natural reading of each is the dashboard's one-click rollback.
- Builds from before Phase 1 gate the search routes and the six history actions on `!!auth()` alone
  (`src/app/api/search/history/route.ts:16`, `src/app/api/search/library/route.ts:22`,
  `src/app/(app)/history-actions.ts:29-31`) and read "the" store with the database token in their
  environment. §11.4 step 5 swaps that variable for the group token but never invalidates the old
  `lazyboy` token.

Two ways it bites:

1. **Phase 0, on today's Hobby plan.** The deploy that rotates `AUTH_SECRET` misbehaves and someone
   clicks Instant Rollback. The only target is the previous deployment, which today is the owner-guard
   build (production's current deployment, created Oct 14 at 8:40 PM per the project settings), built
   with the old secret: the incident's second account is signed in as Rem again, with an ungated
   `logout`. On Pro, one rollback further also removes the owner guard, and that account's next
   sign-in overwrites the token row as on Oct 14.
2. **After Phase 4, if the team moves to Pro** (§15 and decision 12 contemplate it). Every build
   between Phase 0 and Phase 1 shares the current `AUTH_SECRET`. A rollback to one of them puts
   single-user code in front of friends' valid cookies. The plaintext token row is gone by then (§11.4
   step 7), so its pages send them to `/login`, but the routes gated on `!!auth()` alone still answer:
   a friend's next `GET /api/search/history` returns Rem's whole history, and `/api/search/library`
   Rem's library.

Skew Protection widens this on Pro. Vercel enables it by default for projects created after Nov 19,
2024 (this one: June 3, 2026, `vercel project inspect`); it routes same-origin requests carrying
`?dpl=`, an `x-deployment-id` header or a `__vdpl` cookie to that deployment, by default for a day after the
deployment's creation and up to the retention limit if raised (https://vercel.com/docs/skew-protection,
fetched Oct 15). Each rotation then has a tail of at least a day. On Hobby it is unavailable, and
today's public `/login` carries no `dpl` parameter and sets no `__vdpl` cookie (§5), so pinning is
off now; GOTCHAS "Deployment skew + stale tabs" and STORE_MIGRATION §8 step 11 assume it is on. What
protects old builds today is Deployment Protection: `ssoProtection.deploymentType` is
`all_except_custom_domains`, so deployment URLs need a Vercel login while the production `.vercel.app`
alias stays public.

Fix, all cheap:

1. Rotate `AUTH_SECRET` again in Phase 1's deploy. Phase 1 already refuses every cookie without a uid,
   so Rem signs in once either way (§11.4); with a new secret no pre-Phase-1 build can decrypt a
   post-Phase-1 cookie, and a rollback across that boundary signs people out instead of letting them in.
2. Once Phase 0 has run a day, delete the production deployments built before the rotation
   (`vercel rm <url>`), so no rollback can reach the old secret; a bad deploy is then fixed by a
   rebuild. Before Phase 4, delete every production deployment built before Phase 1.
3. Write the rollback rule into §13.1: rebuild the previous commit with today's environment; never
   Instant Rollback or promote across a phase boundary or a secret rotation.
4. In Phase 2 step 1, invalidate the old `lazyboy` database token before minting the group token
   (invalidation is group-wide, C §8.2, so it has to come first), so pre-Phase-2 builds lose their
   store credential.
5. Add to Phase 0's reads and §13.2's gates: Deployment Protection stays at Standard or stricter; on
   Pro, Skew Protection is off, or a Skew Protection Threshold is set at every phase deploy and every
   rotation (Vercel's documented way to stop older deployments serving).

### R2 (Medium). Disabling a user does not stop their sync

§12.1: `status = 'disabled'` ends sessions at the next request "and their sync at the next claim,
which skips users who are not active". §13.1 makes it Phase 4's rollback ("sessions die and sync
stops at once") and §6.6 the answer to a misbehaving friend. But the claim in §7.2 leases on
`sync_state.state NOT IN ('needs_reconnect', 'removed', 'paused')` alone; the join that follows
fetches tokens and database names and is not said to filter on `users.status`, and nothing in the
plan writes `sync_state.state` when `users.status` changes. T6 tests leases and double claims, not
status.

Scenario: Rem disables a friend after a suspected compromise. Their sessions die; the cron keeps
refreshing their token, probing and harvesting their account and spending the shared quota,
indefinitely. The two status columns can drift the other way too: `needs_reconnect` exists in both
(§4.2), written by different paths.

Fix: the claim joins `users` and requires `u.status = 'active'` (one primary-key probe per due row),
or one function owns both columns and writes them in one transaction. T6 adds: a `disabled`,
`deleting` or `needs_reconnect` user is never claimed.

### R3 (Medium). A deleted user's token can be written back after deletion, and nothing sweeps it

§12.3 step 1 deletes the token row; step 5 deletes the `users` row last. The cron's step refreshes a
token "if under 60 s remain" and writes it with `setTokens(uid, t)` (§5.2, §7.2), which checks only
`t.uid === uid`. The lease compare-and-set protects `sync_state` alone ("a step that outlived its
lease writes nothing to the queue"). The job finds unfinished work through the `users` row.

Scenario: the tick claims friend F; the step starts a refresh (lock, then a 0.3-3 s call to the token
endpoint). F presses "Disconnect and delete"; `after()` runs steps 1, 2 and 5 in about a second. The
refresh returns and upserts F's tokens. A live 13-scope grant of a person who asked to be deleted now
sits in `lazyboy-app`, decryptable by production; Spotify keeps it valid until F removes the app, and
this app's refresh tokens do not rotate (01e F2). No `users` row points at it, so no retry finds it,
and the nightly backup copies it. The same race runs from any request refreshing in the jwt callback.

Fix: token writes are conditional on a live owner (`INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM
users WHERE uid = :uid AND status IN ('active', 'needs_reconnect'))`, and the refresh's write as an
`UPDATE` with the same condition), so a write after step 1 sets `deleting` lands nothing. The job's
last step, after the 50-second lease window, deletes the uid's `user_tokens`, `sync_state` and lock
rows again and asserts none remain. The daily route deletes `user_tokens` and `sync_state` rows whose
uid has no `users` row. T11 runs a refresh concurrently with the job.

### R4 (Medium). One error code can destroy every friend's database, and an expiry can be filed as a revocation

Decision 14 and §12.3 destroy a friend's database at once on an `invalid_grant` within six months of
`granted_at`. §7.8 guards the 403 case ("never when every user failed the same way in one tick") but
not this one. Spotify answers `invalid_grant` for refresh tokens that are "expired, revoked, or
otherwise invalid" (01e §5.7); what else invalidates a grant, a client-secret rotation or an account
event, is undocumented (01e §3.2, §8). On Turso's Free plan a destroyed database cannot be undeleted
(the quote in §12.3 is "on paid plans"), and §15 allows staying on Free, so unless Rem takes decision
11's Developer plan, recovery is a nightly backup restored by hand, up to a day of plays short.

The second path is inside the plan. `granted_at` is a plaintext column beside the blob (§4.2), set at
sign-in, and today's sign-in write takes no refresh lock (`src/lib/auth.ts:352-362`). A cron refresh
that read the old grant before a friend's monthly sign-in and writes after it leaves the old grant's
refresh token next to the new `granted_at`. Six months after the old grant, its `invalid_grant`
arrives with `granted_at` under six months, and the plan reads an expiry as a revocation.

Fix:

1. Two or more users with `invalid_grant` inside an hour is an app-wide incident: stop calls, keep all
   data, alert Rem. The same rule §7.8 already applies to 403s.
2. Confirm a single user's `invalid_grant` with one more refresh at least 10 minutes later before
   deleting; that still fits Spotify's five days.
3. Refresh writes are compare-and-set on the blob they read, so a concurrent sign-in wins; keep
   `granted_at` inside the encrypted blob, where the associated data binds it, or change it only
   when a new refresh token is written.
4. Decision 14 states the guard, so Rem decides on the rule as it will run.

### R5 (Medium). Sessions can be renewed indefinitely; the 30-day bound the plan uses does not hold

Auth.js re-encodes the JWT with a fresh expiry on every session read (`@auth/core` 0.41.2
`lib/actions/session.js:33-50`; `jwt.js:58` sets `exp` to now plus `maxAge`), and
`GET /api/auth/session` delivers that cookie, which this app's route passes through
(`src/app/api/auth/[...nextauth]/route.ts:16-18`). 01e §1.4 is right that the app never calls the
route; anyone holding a cookie can. The plan relies on the opposite: "Sessions stay a fixed 30 days,
never renewed" (§5.4), and decision 1 says a pre-guard browser can act as Rem "until about Nov 13".

Scenario: the incident's second account, or anyone with a copied cookie, calls `/api/auth/session`
every few weeks. Before Phase 2 nothing but an `AUTH_SECRET` rotation ends that session; after it,
only an epoch bump does, so a theft nobody notices lasts for good. §5.4's "every sign-in restarts the
six-month clock, so an active user never reaches it" also assumes a monthly sign-in.

Fix: an `auth_time` claim written at sign-in only, and the jwt callback returns null once
`now − auth_time` passes 30 days. T5 adds that known answer. Correct decision 1: the pre-guard
session ends when `AUTH_SECRET` rotates, not on Nov 13, which makes Phase 0 more urgent. `auth_time`
also gives R11 its recent-sign-in check.

### R6 (Medium-Low). The plan never says the identity check fails closed, and today's code fails open

Today's jwt callback returns the cookie untouched when the token read throws
(`src/lib/auth.ts:379-387`) and when the read after a failed refresh throws (`:436-438`), on purpose,
so a store hiccup does not sign Rem out. §5.1 lists four cases that return null (no uid, unknown uid,
wrong status, stale epoch) and says nothing about a failed read. A Phase 2 lane moving today's
callback onto the app database is likely to carry the fail-open branch with it.

Scenario: the `lazyboy-app` read times out while a user database answers (separate databases need
not fail together). A session that "sign out everywhere" ended, or a disabled user's, passes the jwt
callback unchanged; `requireUser()` takes the uid from the cookie; the request reads that user's
data. A stolen cookie that an epoch bump revoked works again for as long as the fault lasts.

Fix: on a failed identity read, keep the cookie (no forced sign-out, today's behaviour) but mint no
uid; `requireUser()` refuses with a retryable error. One sentence in §5.1 and one known answer in T5
("identity read throws: no uid, cookie unchanged").

### R7 (Medium-Low). The isolation tripwire can be forged by any user and is lost whenever the Zenbook is

§6.5 logs isolation events "to `client_metrics`", counts them on `/usage`, and treats one as "a
candidate for Spotify's 24-hour breach notice". `client_metrics` is the table `/api/metrics` fills for
any signed-in user, with a free-text `event` of 64 characters and free `page` and `meta`
(`src/app/api/metrics/route.ts:32-44`). The telemetry client makes one attempt with a 4-second timeout
and is never awaited (§3), and the Zenbook reboots for 6-8 minutes daily and stalled 103 times in four
weeks (§14.5).

Scenario: a friend posts `{"events":[{"page":"/home","event":"isolation"}]}` and Rem's admin view
starts a breach investigation. The other way round, a real cross-user event during a Zenbook outage
leaves no record anywhere: target I's runtime detector is blind exactly when the store is degraded.

Fix: the server writes isolation events, awaited, to a small table in `lazyboy-app` (expected count
zero, so it costs nothing), plus a `console.error` with a fixed prefix; `/usage` counts that table.
`/api/metrics` refuses reserved event names and takes the uid from the session, never the body.

### R8 (Medium-Low). `TURSO_PLATFORM_TOKEN` in `.env.local` makes "dev can never reach a friend" untrue

§5.5 gives dev the platform token ("for the invite and migrate scripts") while §2.3 says "dev can never
reach a friend" and §6.2 layer 7 "dev reaches only Rem's database". The platform token creates and
destroys databases and mints database and group tokens (01e §3.2: after the migration it "is worth
the same as the store token"). `next dev` loads `.env.local` into the server process, and
STORE_MIGRATION §8 step 15 keeps a copy of the file in a lane's scratch directory.

Someone deliberately running code as Rem on the Mac owns production anyway through the Vercel CLI's
login, so the added exposure is accidental: every dev server, every dependency it loads and every
copy lanes make of `.env.local` carries a credential that reads every friend's history and can
destroy their databases, and the plan states the opposite as a guarantee.

Fix: keep the platform token out of `.env.local`, in the macOS Keychain or a mode-600 file outside
the repo, read only by `scripts/invite.mjs` and `scripts/migrate.mjs`. And test the scoping the dev
row rests on: a token minted for `lazyboy`, tried against a throwaway `lb-u-test` in the same group,
must get a 401 (Turso's docs say database tokens are per database, C §8.2; nobody has tried it).

### R9 (Medium-Low). The production token key leaves Vercel in three procedures, and rotating it does not make old copies unreadable

§5.3 and §5.5 keep `TOKEN_KEYS` in Production only, and "the production key never sits in
`.env.local`". Three steps need it elsewhere: §11.4 step 4 encrypts Rem's production row as part of
steps that begin "On the Mac"; §5.3's rotation has "a one-off script" re-encrypt the rows nobody
refreshed; §11.4's late rollback has "a script" decrypt Rem's blob. Lanes on this Mac write
credentials to mode-600 scratch files as routine (STORE_MIGRATION §8 steps 8 and 15).

Separately, §12.3 says a rotation within five days of a deletion "leaves that copy undecryptable".
The old key survives in Rem's password manager, which §5.3 names as the backup, and in the
environment of every deployment built before the rotation (R1), kept 30 days.

Fix: do all three in the runtime. Phase 2's first tick encrypts `meta.spotify_tokens` into
`user_tokens` when no row exists; the daily route re-encrypts any blob not under the first key; a
rollback flag makes the runtime write the plaintext row back. The key then never leaves Vercel. When
an old key is dropped, delete it from the password manager and delete the deployments built with it,
or take decision 16's alternative and name the vendor's ten-day copy in the privacy policy.

### R10 (Medium-Low). From Phase 4 the internet-facing Zenbook holds a read credential for every friend

§5.5 puts a read-only group token on the Zenbook for backups, and §12.4 keeps four days of every
friend's backups there and on OneDrive. sqld and the meter run as systemd user units under the same
account as the backup job, the recorder's `tokens.json` (Rem's grant) and rclone (01f §3.1). The meter
on `:8090` is published through a Funnel whose hostname the public repo prints (01e §2.1), and it
parses the body of every query POST it forwards, unauthenticated ones included, once sqld has
answered (`ops/zenbook-meter/meter-proxy.mjs:110-145`).
A per-database token would not narrow it, since the backup reads every database (A §2.1).

Scenario: a flaw in the Funnel-facing meter or sqld gives a shell as that account; it reads the group
token, every friend's live history, four days of backups and the OneDrive token.

Fix: run sqld and the meter under a separate Unix account with no read access to `~/lazyboy-backup`,
the rclone config or `~/lazyboy-recorder`; the backup job and its token stay where they are. §12.2's
policy text already names the laptop.

### R11 (Low). Irreversible actions need only a session, and the admin's session can destroy friends

"Disconnect and delete" runs the deletion job inline (§5.4, §12.3), and "Rem removing a user" is one
of its triggers, run "inline in `after()` for a disconnect or a removal", so removal is a runtime
action. §16.2 reasons that "cross-site scripting acts as its victim only"; when the victim is the
admin, the victim's powers include destroying a friend's database. No CSP is planned (§16.2). Today's
code has no HTML sink besides the static root script (`src/app/layout.tsx:44`; `grep` for
`dangerouslySetInnerHTML`, `innerHTML`, `eval`), so an XSS is unlikely; this bounds what one would
cost, and what a stolen cookie can do.

Fix: removal and disabling run only from scripts on the Mac, as invites do (§12.1), so the runtime
holds no admin mutation. "Disconnect and delete" asks for a typed confirmation and a sign-in within
the last 10 minutes (R5's `auth_time`; otherwise a fresh Spotify consent first).

### R12 (Low). Immutable segment URLs leave a year of a user's history in a shared browser's HTTP cache

§9.1 serves segments `private, max-age=31536000, immutable` under `/api/search/h/<uid>/…`, and §6.2
layer 6 relies on a client-side clear at sign-out, with `Clear-Site-Data` "where the browser honours
it". No page script can evict HTTP-cache entries, and sign-out is a server action (01b §7 item 1),
whose response cannot carry an arbitrary header such as `Clear-Site-Data`; that takes a route
handler.

Scenario: A signs out of a shared computer. A's monthly bodies stay in the HTTP cache for a year,
readable through devtools or by any same-origin script that learned A's uid, which sat in the storage
keys until the clear.

Fix: serve segments and the library body `private, no-store`. Phase E's IndexedDB copy is the
repeat-visit store (S1's budget in §14.1 reads IndexedDB, not the HTTP cache), and it can be cleared;
a device that lacks a segment fetches it once from the Data Cache either way. If `Clear-Site-Data`
stays, send it from a sign-out route handler.

### R13 (Low). Two Spotify-spending paths have no server-side bound

Rule 3 of §3 says "no client call can spend more than the server allows", and §6.6 bounds
`dailyStatsAction`, `searchPlaysAction` and `/api/playlists/[id]/tracks`. `/api/now-playing` makes one
or two player calls and a context lookup per request (`src/app/api/now-playing/route.ts:30-56`) with
no server-side interval, and the player actions (`src/app/(app)/actions.ts:310-356, 526-541`) have
none either. §7.6: "a rate-limit 429 pauses every user's capture for its duration".

Fix: a per-uid minimum interval on now-playing (an in-process memo of the last answer for 3-5
seconds; with Fluid compute on, `resourceConfig.fluid: true`, few instances serve everyone, so it
catches a stuck tab cheaply) and a per-uid token bucket on the player actions. A determined user stays
§6.6's `disabled` case, once R2 is fixed.

### R14 (Low). Cron path hardening

- **An unconditional write per tick.** Every tick stamps `app_meta.last_tick_at` (§4.2), and the
  route has no rate limit beyond its secret. A leaked `CRON_SECRET_EXT`, held by a third party, can
  call it as fast as it likes: at 100 calls a second that is ~8.6M writes a day [estimate] against the
  free plan's 10M a month, after which every write fails with `BLOCKED` until the 1st (Turso's
  usage page, quoted in 01f §4.2; the org runs with overages disabled). Stamp
  conditionally (`… SET value = :now WHERE key = 'last_tick_at' AND value < :now − 20000`) and return
  200 at once when nothing changed; that is also the rate limit.
- **Which routes each secret opens.** `CRON_SECRET_EXT` should open `/api/cron/sync` only, never the
  daily route that runs deletions with the platform token.
- **What the third party sees.** cron-job.org keeps response bodies in its execution history; per-user
  outcomes there are a minute-by-minute record of when each friend listens. Answer that caller a bare
  `{"ok":true}` and keep per-user outcomes for the Zenbook's caller and the logs.
- **A test.** T3 exempts `/api/cron/*` and nothing tests their secrets. T13: each cron route refuses
  no secret, a wrong one, and the other caller's where it should; the constant-time compare
  (`src/app/api/cron/sync/route.ts:45-66`) stays.

### R15 (Low). Smaller gaps in the layers

- **The owner check's cache key.** "One statement per database per cold process" (§14.6). Cached per
  database, a second uid mapped to an already-verified database skips the check, which is the M9 case
  it exists for. Cache verified `(uid, db_name)` pairs; T8 opens A, then B pointed at A's file, in one
  process.
- **How `requireUser()` gets the verified uid.** `auth()` returns what the session callback returns
  (`next-auth` beta.31 `lib/index.js:22-31`); the plan keeps the uid off the Session type (§5.1); a
  `cache()` hand-off from the jwt callback may be a pass-through in route handlers (01b §3.3,
  unverified), which would refuse every route. Put the verified uid on the session: the layout renders
  it into the page anyway (§5.1), so `/api/auth/session` serving it to its own user costs nothing.
- **Server errors escape deletion.** `onRequestError` writes `server-error` rows with the request path
  and the error message and no user (`src/instrumentation.ts:17-24`). Segment paths carry the uid, so
  delete-by-uid misses those rows, and `/usage` shows them. Record the uid parsed from the path, strip
  it from `page`, and delete by it.
- **S4's patterns.** It flags top-level `let`, module-scope `new Map(` and `globalThis` writes; a
  module-scope `new Set(`, an array or object literal mutated later, or a static class field passes.
  Use the TypeScript compiler API (C's structural test) to list every module-scope binding that is
  ever mutated. Today's set matches the plan's table (`grep`, §5).
- **The admin view.** `handoff` beacons will carry track ids (§6.2 layer 7) and `api_log` paths carry
  playlist ids, both shown on `/usage`; §12.2's "there is no admin view of anyone's listening" needs
  them aggregated there, or the policy says so.
- **One user's quota ban applied to all.** If the quota turns out to be per user, applying one user's
  `QUOTA_EXCEEDED` cooldown to everyone (§7.8) breaks A3; it also blinds §7.9's passive check, because
  nobody else calls during the ban, so "one user refused" can never be observed. After one user's ban,
  let one other user's harvest through as the probe before the cooldown goes app-wide.

### R16 (Low, process). Land Phase 0 before the next push

The repo is public (01e §3.1). Local `main` is 202 commits ahead of `origin/main` and nothing under
`docs/multi-user/` is on origin (`git log origin/main -- docs/multi-user` is empty). The next push of
`main` (at the latest when STORE_MIGRATION's lanes run, from Oct 15, 8 PM) publishes 01b §6 and 01e
F1: a pre-guard session that still acts as the owner, and a `logout` with no gate. Land Phase 0
first, or hold these files off `origin` until it ships.

## 2. What holds up

I tried to break each of these and could not; several I checked against production settings.

- **A database per user, with the owner stamped inside it and checked on open.** The fifty-odd
  whole-table statements of 01a §7.3 (D12-D19) are correct by construction, and a mapping slip
  becomes a refused open instead of a leak (with R15's cache key). It is the strongest single choice
  in the plan.
- **The random uid that is never reused.** The restore argument against `AUTOINCREMENT` (§4.4) is
  right, and the uid is not a credential, so it can sit in URLs and ETags. `Referrer-Policy:
  strict-origin-when-cross-origin` (`next.config.ts`) keeps uid-bearing request paths out of the
  Referer sent to Spotify's image CDN.
- **The gate before the reads on Home**, and the rejection of B's parallel open from a cookie field
  (§5.1): a second way to mint a user handle is exactly what the branded type exists to prevent.
- **The token core.** A keyed in-flight refresh closes 01e A2, the one silent cross-user token leak in
  today's code (`src/lib/auth.ts:188-196` ignores its argument while a refresh is in flight). Per-user
  locks, tokens that carry their owner, AES-256-GCM with the uid as associated data (a moved
  ciphertext fails to authenticate), removal of the cookie-held token paths (`auth.ts:367-374,
  388-405`), and a decrypt failure that logs the uid and never the blob.
- **Sign-in binding.** `account_id` as the link, refused when absent; the compare-and-set claim; two
  independent gates, so a Spotify id that changed hands still has to be on Rem's dashboard list to get
  past `/v1/me`; the profile fetched uncached; uid and epoch taken from the `users` row at sign-in.
  Auth.js builds the sign-in token from the signing-in user alone (01e §5.6), so no fixation.
- **The web basics already in place.** PKCE on the OAuth flow (01e §1.1); an httpOnly, Secure,
  SameSite=Lax cookie; Next's same-origin check on server actions; no CORS headers; `X-Frame-Options:
  DENY`. A `grep` for `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `eval` and
  `new Function` under `src/` finds only the static canonicalization script (`src/app/layout.tsx:44`),
  and no `href` takes a value a stranger controls.
- **Vercel settings, read for this review (§5).** Every secret in Production is already `sensitive`
  (`AUTH_SECRET`, `CRON_SECRET`, `TURSO_AUTH_TOKEN`, `TURSO_DATABASE_URL`, `TURSO_PLATFORM_TOKEN`,
  `SPOTIFY_CLIENT_*`, `CRONJOB_*`; only `AUTH_URL` is `encrypted`), so `vercel env pull` returns none of
  them, which answers §16.2's open check on `TURSO_AUTH_TOKEN`. Git fork protection is on
  (`gitForkProtection: true`), which answers 01e §8's question about pull requests from forks of the
  public repo building with Preview's variables. Deployment Protection covers every deployment URL
  (`all_except_custom_domains`). `SPOTIFY_OWNER_ID` is still absent from Production, so Phase 0's item
  stands.
- **The census of process state.** A `grep` for module-scope `let`, `new Map`, `new Set` and
  `globalThis` under `src/` finds the plan's table and nothing else that holds user state
  (`apiLogWrites`, `db.ts:2601`, is a counter). Fluid compute is on (`resourceConfig.fluid: true`), so
  one instance serves concurrent requests from different users, which is what T4's "two users in one
  invocation" models.
- **The cron's secret check**: constant-time and fail-closed (`src/app/api/cron/sync/route.ts:45-66`).
- **Deletion by destroying the database**, with T11's three refusals (the admin, `lazyboy`, a name or
  owner mismatch) and backups that list only active users; R3 and R4 tighten its edges, not its
  shape.
- **The recorder staying Rem's alone**, and the rule that every isolation test is first shown failing
  against a planted bug.

## 3. STORE_MIGRATION, from this lens

Nothing here argues for holding lanes 1901-1911. Of the plan's six edits (§10.2), edits 2, 4 and 5
close live exposures (Preview on the production store; 13-scope grants in every backup; plaintext
copies in scratch) and should go in before lane 1901; edit 3's opaque browser key is right. Three
additions:

1. **Phase 0 before lane 1903's flip** (R1, R16). Then the deployment a one-click rollback reaches
   during the cutover was built after the rotation, and the push the lanes make does not publish
   exposures that are still open.
2. **Name the token Phase 2 retires.** Step 8 mints a full-access, no-expiry token for `lazyboy`
   (STORE_MIGRATION §5, step 8). Record it as the credential Phase 2 invalidates before minting the
   group token (R1, fix 4), and give dev a token of its own if dev is to keep one.
3. **A correction for lane 1903's step 11.** It expects fence 503s from "old deployments" that "reload
   to the new build through build-skew". Skew Protection is a Pro feature, the team is on Hobby (01f
   §2.1), and today's production shows no pinning (§5): after the flip, old tabs reach the new
   deployment, and old deployments are only reachable through protected URLs. Fence hits should come
   from dev servers and scripts; an old deployment in the meter log means someone reached a protected
   deployment URL, which is worth a look rather than a wait.

## 4. Tests and checks to add

Each joins the plan's suite (§6.4) under its rule: written red first, shown failing against a planted
bug, then green.

| id | runs | must hold | from |
|---|---|---|---|
| T5 + | the identity read throwing; a cookie whose `auth_time` is 31 days old | no uid minted and the cookie left as it was; the old cookie refused | R6, R5 |
| T6 + | a claim with `disabled`, `deleting` and `needs_reconnect` users due | none of them claimed | R2 |
| T8 + | A opened, then B with its row pointing at A's file, in one process | B's open refused, logged, A's file unchanged | R15 |
| T11 + | a token refresh for B finishing while B's deletion runs; then the daily sweep | no `user_tokens`, `sync_state` or lock row for B afterwards | R3 |
| T13 | every cron route with no secret, a wrong one, and the other caller's | refused where the caller has no business; `CRON_SECRET_EXT` opens `/api/cron/sync` only | R14 |
| T14 | `invalid_grant` for two users inside an hour; a refresh racing a sign-in | no deletion, an alert; the sign-in's tokens and `granted_at` survive | R4 |
| T15 | `/api/metrics` with an `isolation` event; an owner mismatch while telemetry is down | the client's event refused; the server's event stored in `lazyboy-app` | R7 |
| header | the segment and library routes | `Cache-Control: private, no-store` | R12 |
| S4' | the TypeScript compiler API over `src/` | every mutated module-scope binding on the reviewed list | R15 |
| one-off, Phase 2 | the `lazyboy` database token against a throwaway `lb-u-test` | 401 | R8 |
| deploy checklist | each phase deploy and each secret rotation | no Instant Rollback or promote across it; pre-rotation production deployments deleted; Deployment Protection at Standard or stricter; on Pro, a Skew Protection Threshold set | R1 |

## 5. What I ran

Oct 14, 11:39 PM to Oct 15, about 12:10 AM, on the Mac. Nothing wrote to the store, the Zenbook,
Turso, Vercel or Spotify; the only file written in the repo is this one, and the scratch files
(extracted tarballs, three field-filter scripts, the fetched `/login` page) under
`/tmp/lb_sec_review/` were deleted at the end.

- Read in full: `PLAN.md`, `01b-surface.md`, `01e-auth.md`. Read the parts that bear on this lens and
  scanned the rest with `grep` for security terms: `01a` §7, `01c` §0, §3, §5.4, §5.7, `01d` §4,
  `01f` §2.1, §3, §4.2; design A §2.1 and design C §8.1-8.2 on Turso tokens; GOTCHAS "Deployment skew +
  stale tabs", "Architecture added recently" and "Production security"; STORE_MIGRATION §8 and its
  rollback; `docs/quota-forensic/OLD_BUILD_COST.md`'s opening.
- Code read: `src/lib/auth.ts`, `owner.ts`, `session.ts`, `tasks/registry.ts`, `playlists-sync.ts`,
  `spotify/client.ts:1-120`, `handoff.ts`; `src/app/(app)/actions.ts:1-120`, `history-actions.ts`,
  `layout.tsx`, `usage/page.tsx:80-95, 238-262`, `(auth)/login/page.tsx`; every route under
  `src/app/api/` except `cron/usage-check`; `src/instrumentation.ts`; `next.config.ts`; `vercel.json`;
  `ops/zenbook-meter/meter-proxy.mjs`. `grep` under `src/` for module-scope state and for HTML sinks.
- Auth.js internals: the `@auth/core` 0.41.2 and `next-auth` 5.0.0-beta.31 tarballs lane 0221 kept in
  `~/.claude/broke/scratch/lazyboy_mu/authjs_src_0221/`, extracted to a temporary directory (deleted at
  the end); read `lib/actions/session.js`, `jwt.js` and `next-auth lib/index.js`.
- Vercel, read-only, printing only the fields named: `vercel project inspect lazy-boy`; `vercel api
  /v9/projects/lazy-boy` filtered to `ssoProtection`, `passwordProtection`, the skew fields (absent),
  `gitForkProtection`, `deploymentExpiration`, `resourceConfig` and whether each production alias is a
  `.vercel.app` or custom domain; `vercel api /v9/projects/lazy-boy/env` filtered to name, type and
  target (no values).
- Production app: one anonymous `GET /login`, which reads no store (no cookie means the session
  action returns before the jwt callback). I counted `dpl=` markers in its HTML (0) and looked for a
  `__vdpl` cookie (none) and for server-action ids (one, `login`'s).
- Vercel's documentation, fetched Oct 15: `/docs/instant-rollback` and `/docs/skew-protection`.
- `git status -sb`, `git log origin/main -- docs/multi-user` (empty), `git diff --stat ac6f7fe HEAD --
  src scripts ops tests vercel.json next.config.ts package.json` (empty).
