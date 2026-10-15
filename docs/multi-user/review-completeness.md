# Review of PLAN.md: completeness and product

Lane 0224_lb_mu_review_completeness, Oct 14, 2026. An adversarial review of `docs/multi-user/PLAN.md`
(at `0ca7ab5`) in a fresh context, with one lens: what the plan does not cover at all, steps that are
not reversible, tests that would not catch what they claim to, and decisions it makes that should be
Rem's. Security, scale and migration have their own reviewers; this file stays out of their lanes
except where a gap is a product or completeness gap first. Planning only: nothing here changed code,
data, the Zenbook store, Turso or Vercel. §3 lists everything this lane ran.

Severity: **High** means a friend's data can be lost or exposed, Rem's capture can stop, or a claimed
safety property does not hold as specified, with no step in the plan that would catch it in time.
**Medium** means a real gap the plan should close before the phase that needs it. **Low** means a
note for the phase's lane.

Status: in progress.

## 0. Summary

(to be filled)

## 1. Findings, ranked

### High

#### H1. The plan's alarms reach nobody

**What the plan relies on.** The owner alarm is a 503 to the Zenbook's pinger, "Rem's only alarm that
capture stopped" (§7.2 step 0, PLAN.md:831-836). Isolation events, the runtime detector for every
cross-user bug the tests miss, go to `client_metrics` and are counted on `/usage` (§6.5,
PLAN.md:778-781), and §12.2 names them as the tripwire for Spotify's 24-hour breach notice. The key
rotation due within five days of each friend's deletion "records the due date on `/usage`" (§12.3,
PLAN.md:1540-1543). A friend's dead grant or `removed` state shows on their own banner and on `/usage`.

**What exists.** None of these notifies anyone. The Zenbook unit that is meant to "fail visibly" has no
failure hook: `systemctl --user show lazyboy-cron-sync.service -p OnFailure` prints `OnFailure=`
(empty, read tonight, §4), and `ping.sh` only appends each reply to `ping.log` (01c §1). A failed unit
is seen by whoever runs `systemctl --user --failed` on the Zenbook. Isolation events ride the telemetry
client, "one attempt, 4 s, never awaited" (PLAN.md:248), to a box that reboots for about seven minutes
every night and stalled past 100 s 103 times in four weeks (01f §3.3), so some are dropped as well as
unread. The reason is STORE_MIGRATION's R6, "No new alerting mechanism" (STORE_MIGRATION.md:37). The
plan never says whether R6 binds the multi-user phases; design B read it as binding
(design-b.md:1288-1289).

**Failure.** A cross-user cache hit at 2 AM logs one event, and Rem sees it the next time he opens
`/usage`, which during a quiet soak week can be never; the 24-hour notice to `security@spotify.com`
cannot be met from a log nobody reads. A friend's capture that dies on a Friday loses every play past
their last 50, about three hours of listening (01c §5.7), before either of them knows. A deletion's
five-day clock runs out on a chore that lives on a page.

**Fix.** Ask Rem to lift R6 for the multi-user phases. It is his call; I recommend yes, because friends'
data and two hard clocks now hang on it. Use the channel that already exists and costs nothing: a
cron-job.org job with failure e-mail, the pattern the usage-check route was built around
(ARCHITECTURE.md:190-198, 219-220), calling a new `/api/cron/health` hourly. It answers 500 when an
isolation event was recorded since the last check; the admin is `active` and his `last_ok_at` is older
than 30 minutes; a user has sat in `deleting` for over a day or a key rotation is due within a day; a
friend has been `needs_reconnect`, `removed` or in `backoff` for over six hours; or Turso's month-to-date
reads run ahead of pace. Write each isolation event as one awaited row in the app database as well as
to telemetry, so the check cannot miss one. cron-job.org disables a job after repeated failures, so the
daily route re-enables it with the helper that already does this for the sync job
(`ensureCronJobEnabled`, `src/lib/cronjob.ts:14-48`), given the health job's id. Known answers for each
condition. It has to exist by Phase 1, which is when isolation events start.

#### H2. A friend's history is destroyed, and the friend locked out, on a signal the plan calls "most likely"

**What the plan says.** An `invalid_grant` within six months of `granted_at` "most likely means the user
revoked the app" and runs the deletion job, which destroys `lb-u-<uid>` at day 0 and deletes the `users`
row last (§5.4, PLAN.md:577-581; §12.3, PLAN.md:1497-1513). "The grace for an accidental revocation is
Rem restoring by hand ... if the person reconnects and asks; otherwise they start empty"
(PLAN.md:1522-1524).

**What is wrong with it.**

1. The person cannot reconnect. With the `users` row gone, their next sign-in finds no row and no open
   invite, which §5.1 answers with AccessDenied, "this app is invite-only" (PLAN.md:466-476). Nothing
   tells them their history was deleted, and no restore script is specified. Design A had the two
   pieces the plan dropped: the row stays in `deleting` for five days, a returning sign-in is told the
   account is being deleted, Rem restores with a script, and only then does the row become a tombstone
   (design-a.md:1163-1181).
2. Nothing stops a mass deletion. The "every user failed the same way" guard sits on the 403 row only
   (§7.8, PLAN.md:967); the `invalid_grant` row (PLAN.md:966) and the deletion triggers have none. The
   causes of `invalid_grant` beyond revocation are undocumented: "invalidated by Spotify for some other
   reason, which the docs do not list" (01e §5.7), and whether a password change or another account
   event invalidates grants is unknown (01e §8). One Spotify-side invalidation becomes every friend's
   database destroyed in the next daily run.
3. On Turso Free, which §15 leaves open ("$0 if Rem stays on Free"), a destroyed database cannot be
   undeleted, so the only copy left is the friend's last nightly backup. Design A said the ambiguous
   case would need up to four days of grace before the destroy on Free (design-a.md:1196-1199); the plan
   destroys at day 0 on any plan.
4. The discriminator is unverified. `granted_at` is the last sign-in, and the rule assumes each sign-in
   restarts Spotify's six-month clock (PLAN.md:573-576, from 01e §5.7). Spotify's page says the lifetime
   "starts when the user authorizes your app" and that refreshing does not extend it (01e §2.1); whether
   a re-authorization mints a new refresh token has not been observed from this app. If it does not, a
   friend who joined in December and signs in monthly gets `invalid_grant` in June with `granted_at` a
   month old, and the rule destroys their history as a revocation.

**Fix.** Keep A's `deleting` state and tombstone, with the sign-in message and a written restore script.
Add a mass-event guard: two or more users, or the admin, on `invalid_grant` within 24 hours suspends
automatic deletion and raises H1's alarm. On Free, delay the ambiguous trigger's destroy by up to four
days. Settle the clock question in Phase 0 with the hash-prefix probe 01e already wrote
(`token_rotation_probe.py`, 01e §8): Rem's token row has been rewritten by a sign-in since the incident
(01e §1.2 found `me_id` back on his account by 9:32 PM, which needs his token in the row), so the Oct 15
4:40 AM snapshot shows whether his refresh token still hashes to the pre-incident `d30e33fe`
(01e §2.1). Until that is settled, treat `invalid_grant` as stop-and-keep (`needs_reconnect`). Re-present
decision 14 with the lock-out and the mass-event case in it, and add T11b: two users' `invalid_grant` on
one day destroys nothing and raises the alarm.

#### H3. The versioned open has no rule for a database newer than the code, and dev can migrate Rem's production database

**What the plan says.** On a database's first open, "A current version means nothing more is run. A
version behind by additive steps only ... applies them ... A version behind by a rebuild refuses that
user" (§4.5 step 2, PLAN.md:428-434). Every phase's rollback is "redeploy the previous build" (§13.1,
PLAN.md:1582-1588). Dev holds a `lazyboy` token "so dev reaches Rem's data only" (§5.5, PLAN.md:598;
layer 7, PLAN.md:712-713).

**What is wrong with it.**

1. A database ahead of the code has no rule, and every rollback after a phase that added a step makes
   one. Phase 3 creates `sync_state` in the app database (PLAN.md:1586), so rolling Phase 3 back puts
   Phase 2's build on an app database one step ahead. If the open reads "not current" as an error, the
   identity read fails for every session, Rem's included; on `lazyboy` it refuses Rem ("updating") and
   the cron skips his step (PLAN.md:972). §4.5 step 5's "old code tolerates it" (PLAN.md:440) is true of
   today's `init()`; with a version check it has to be designed back in.
2. Dev runs branch code against Rem's production database. The first dev open of `lazyboy` on a branch
   that declares a new additive step applies it and bumps `schema_version` in production, before review
   and before deploy. The plan takes Preview off the store for exactly this reason (§10.2 edit 2,
   PLAN.md:1296) and leaves dev on it. Rule 5's list of the only changes to Rem's data (PLAN.md:270-273)
   does not survive a dev session, and with problem 1 a dev session can leave production's own code
   looking at a newer database.

**Fix.** Store a `min_reader` version beside `schema_version`: an additive step leaves it, a rebuild
raises it, and code opens any database whose `min_reader` is at or below its own version, ahead or not.
Known answers: old code on a database one additive step ahead opens; one rebuild ahead refuses with a
message. Only production code and `scripts/migrate.mjs` write DDL to a production database: a
non-production process that finds one behind its code refuses to apply steps and says so. Each
rollback cell in §13.1 names the schema state it leaves and why the previous build accepts it.

#### H4. The first two-user run in production is a real friend's

**What the plan says.** "Nothing reaches a friend until it has run on Rem alone" (rule 4, PLAN.md:267-269).
Phases 1-3 run with `SIGNUPS=owner`, which "refuses everyone but the admin" (PLAN.md:477, 1450-1451).
Phase 1's exit is "a week with zero isolation events" (PLAN.md:1584). The canary account is optional and
runs "through Phase 4's first week" (PLAN.md:784-785), beside the first friend.

**What is wrong with it.** Until the first friend signs in, every isolation layer has run only in the
simulated environment. With one user the cross-user cases cannot happen in production, so Phase 1's
exit check cannot fail for the bugs it exists to catch: its zero is a property of having one user. What
the harness cannot reproduce is what the overviews left unverified: React `cache()` in route handlers
and the Data Cache across environments (01b §8, which the plan answers with "the owner stamp and the
keyed boxes make the design correct either way", §16.1), fluid compute running concurrent requests of
different users in one instance (on for this project, 01f §2.1), two real tokens refreshing in one tick,
and how Spotify's quota pools. The runtime detectors meant to catch what slips through fire for the
first time on a friend's data, and with H1 open nobody hears them.

**Fix.** Split Phase 4: ship it with only a canary invited, and invite the first friend a week later. The
canary is a second Spotify account Rem controls, added to the allowlist, signed up through the real
`/join`, used on a second browser and once on Rem's own browser after he signs out (the shared-device
case). Exit checks that can fail: the canary's Home and search hold none of Rem's plays and his hold none
of the canary's; `api_log` attributes each call to the right uid; a planted runtime probe (a cache entry
forged under the canary's key and stamped with Rem's uid) produces exactly one isolation event, and that
event reaches Rem through H1's channel. The canary then leaves through the deletion job, which is §13.2's
"deletion proven" gate run for real. The account needs no Premium of its own for this (Spotify requires
the owner's, 01f §1.2), and removing it frees its place unless the list is grandfathered (M5).

### Medium

#### M1. T3 cannot see nested server components, and new entry points get only half of it

T3 runs "every page, every `"use server"` export and every route handler, found by globbing `src/app`"
(PLAN.md:756). Calling a page function runs its own body and returns JSX; an async server component
nested in that JSX never executes. `/playlists/[id]`'s cold path does its Spotify fetch and its
`storePlaylistTracks` write inside the nested `Tracks` component (`src/app/(app)/playlists/[id]/page.tsx:141-143`,
`152-200`), so T3's "A's file unchanged, every Spotify call on B's bearer" never runs the path 01b B4
names for reading a private playlist by id. No test renders a page today: `tests/` imports route
handlers, actions and lib modules only. Second, the glob finds new entry points and the no-session case
needs no inputs, but "B with A's identifiers in the input" needs to know which arguments are identifiers;
an action added later silently gets the first check and not the second. Layouts are outside the glob,
though the `(app)` layout will render the uid (§5.1, PLAN.md:507-509).

**Fix.** Either render pages through React's server renderer in the harness, or (cheaper) add a static
check that no nested async server component reads user data or calls Spotify, move `Tracks`' fetch into
the gated page body, and test it as B with A's playlist id. Keep a fixture registry keyed by entry point
that fails the suite when the glob finds one without an identifier-input entry. Add layouts to the glob.

#### M2. T1 has no positive control, its instrument is a file hash, and the planted bugs are thrown away

T1 calls every `UserStore` method, "enumerated from the object so a new method is covered automatically"
(PLAN.md:754). Enumeration supplies the method, not inputs that reach its writes: a method called with
placeholder arguments that returns early leaves B's file unchanged and passes, and nothing checks that
the call did its work on A. The instrument is a sha256 of B's database file (PLAN.md:750, 754, 761,
764). The harness pins no journal mode (`tests/setup.ts` sets only the URL), and under WAL a committed
write sits in the `-wal` file until a checkpoint while the main file's bytes stay the same. Which mode
`@libsql/client` 0.17 uses for `file:` URLs I could not check (this checkout has no `node_modules`). The
planted-bug rule (PLAN.md:736-738) is a one-time act: once the suite is green nothing shows it can still
fail, so a later edit, say the cache stub drifting back to today's pass-through
(`tests/stubs/next-cache.ts:4-10`), leaves T2 passing with nothing behind it.

**Fix.** A fixture per method with a positive control: every write method changes A's content, every
read returns an A marker, and a method with no fixture fails the suite. Compare an ordered logical dump of
every table instead of file bytes, and pin the journal mode in the harness. Keep the planted bugs as a
permanent harness self-test (an unkeyed `unstable_cache`, a shared in-flight map, a URL template that
ignores the uid), each asserting the suite reports it.

#### M3. The one-variable way back does not stop friends already inside, and there is no incident runbook

`SIGNUPS=owner` is "Phase 4's one-variable way back" (PLAN.md:478, 1451, 1587), but as written it acts at
sign-in (§5.1). Friends already signed in keep their 30-day sessions, and the cron keeps capturing them.
The per-user `status = 'disabled'` does stop a friend, but it is a write to the app database for which
the plan names no admin action or script. The plan names the 24-hour Spotify duty (§12.2) and no steps
for a suspected cross-user exposure. Rolling Phase 4's code back to Phase 3's also removes the deletion
job, so a deletion in flight stops counting toward its five days; the rollback cell does not say so.

**Fix.** Make `SIGNUPS=owner` also refuse non-admin uids at the identity check and skip them at the claim,
so one environment change and a redeploy freezes every friend, with a test. Add
`scripts/user.mjs --disable | --enable | --remove`. Add a short runbook (in §13 or `docs/SECURITY.md`):
freeze; keep the evidence (isolation codes, `api_log` by uid); work out whose data reached whom; notify
Spotify within 24 hours and the affected friend directly; move the affected shape tokens; re-run T1-T12;
unfreeze. Note in Phase 4's rollback that in-flight deletions are finished by script.

#### M4. The plan never says what a friend gets

Rem asked to "scope out multi user support"; the plan scopes the engineering and leaves the product a
friend receives unwritten.

- **Playback needs the friend's own Premium.** Spotify's start-playback page: "This API only works for
  users who have Spotify Premium" (fetched tonight, §4). The app's play, queue, resume and
  play-from-playlist actions call those endpoints (01b §2.2, `actions.ts:310-356, 526-541, 557-663`).
  Development mode no longer returns `product` from `/me` (01e §1.1), so the app cannot check first, and
  the client retries the 403 once and surfaces a generic error (`src/lib/spotify/client.ts:196-201`).
  Spotify's quota-modes page requires Premium only of the owner.
- **The invite needs the friend's Spotify login e-mail.** The same page: "enter the name and Spotify
  email address of the user that you want to enable to use your app". §12.1's flow names only the Spotify
  id (PLAN.md:1437-1443), §12.2 says there is no e-mail (PLAN.md:1482-1483), and the policy's list of
  what is collected (PLAN.md:1487-1493) leaves it out. Rem will hold every friend's address, which is
  also the notice channel the plan says does not exist, once the friend agrees to it at `/join`.
- **First run.** A friend's history starts with the first harvest's last 50 plays; the first library
  scan takes one to two minutes (§7.7); the strip and the all-time card start nearly empty; and no
  recorder backs their capture (§7.9), so their loss floor is the 50-play window alone. None of this is
  in a test or in what the invite tells them.
- Compare-a-friend and the static `/friends` page do nothing in development mode for anyone (01f §1.2:
  `GET /users/{id}/playlists` is gone with "No replacement").

**Fix.** A short "what a friend gets" section, written once and reused as the invite text: the feature
list with what needs Premium, the history start, the loss floor, retention, the five-person cap. A 403
from a player endpoint answers "needs Spotify Premium" in the UI. The e-mail goes in the policy's list,
with an opt-in for account notices at `/join`. A harness test renders Home for a freshly provisioned user
with no plays. Hide or label the features development mode killed.

#### M5. Five ways a friend's lifecycle goes wrong

- **A friend removed from Spotify's allowlist cannot delete.** The cron marks them `removed` (§7.8,
  PLAN.md:967), which is not a deletion trigger (§12.3, PLAN.md:1497-1500). They can no longer sign in
  (`/v1/me` answers 403), so "Disconnect and delete" is out of reach, and their data stays until twelve
  months after their last sign-in.
- **An inactive friend is captured for six months, then deleted without notice.** Capture runs off the
  stored grant until it expires, up to six months after the last sign-in (§5.4), spending the shared
  recently-played budget (§7.5). The data then sits until month twelve and is deleted, with "every
  notice" confined to an app the person no longer opens (PLAN.md:1478-1483).
- **Backups cover only `active` friends** (PLAN.md:1556-1559). A friend in `needs_reconnect` or
  `disabled` still has a database and, four days later, no backup of it.
- **Nothing exports a friend's history** before a deletion, requested or automatic.
- **Invites never expire.** An `invited` row holds a provisioned database and counts toward five in
  `invite.mjs` (PLAN.md:1438-1441), and the plan has no revoke command. If the dashboard shows a
  grandfathered list above five, removing anyone from it is permanent: "These limits only restrict what
  you can create or add going forward" (01f §1.2).

**Fix.** Seven days in `removed` raises H1's alarm and prompts Rem to run the deletion; the policy names
a way to request deletion outside the app. Capture pauses after about 60 days without a sign-in
(`dormant`, resumed at the next sign-in, the gap's plays beyond 50 being the honest cost). Back up every
user not in `deleting`. An export of the user's own history segments (the JSON bodies §9.1 already
serves) on the disconnect page and before any automatic deletion. `invite.mjs --revoke`, and a 14-day
expiry the daily route enforces. Put the grandfathering consequence next to decision 5's dashboard read.

#### M6. P4's exit check skips the events the plan says need the dirty mark

The Home payload patch falls back to a rebuild for out-of-order inserts, time-zone and shape changes, and
"any derived-column event that touches a play in the payload's 16 days (a context name resolving, an
orphan flip)"; without the mark "a stale 'From' could sit in it for days" (§8.4, PLAN.md:1093-1100). The
exit check is "patched payload = rebuilt payload after a day of synthetic harvests" (PLAN.md:1588). A day
of appends passes with every dirty-mark path broken.

**Fix.** Run the equality over a scripted day that includes each non-append event: an out-of-order
insert, a context name resolving for a play inside the 16 days, an orphan flip from a playlist change, a
time-zone change and a duration change, with patched = rebuilt after each.

#### M7. No bootstrap for an empty install, which "run your own copy" and every new checkout need

Target U says that past five, "each person runs their own copy, which is the one-user case of the same
code" (PLAN.md:79). The README offers a deploy button and a three-step local start (`README.md:26-45`),
and `npm run setup` promises that a new user "only has to paste their Spotify Client ID + Secret"
(`scripts/setup.mjs:1-3`). After Phase 2 the app needs an app database, a `users` row for its owner,
`OWNER_UID`, `TOKEN_KEYS` and a database named through the URL template; §11.4 creates those for Rem by
hand, and nothing creates them for an empty install. Dev's own app database (§5.5) has no seeding step
either. So the "own copy" path, which is the plan's whole answer to more than five people, stops working
at Phase 2.

**Fix.** On an empty app database, the first sign-in that matches `SPOTIFY_OWNER_ID` provisions the admin
row and a user database (or `npm run setup` does), with a harness test that boots from nothing. The phase
that breaks the README updates it. Decision 6 states what an own copy costs each person: their own
Premium, developer app, Turso database and pinger, and about an hour of setup (01f option E).

### Low

**L1. T12 cannot rehearse the token step on a backup copy.** T12 runs the Phase 2 migration "on a local
copy of a nightly backup" against §11.4 step 6, which checks "the blob decrypting to the plaintext row"
(PLAN.md:765, 1412-1415). Edit 4 strips the `spotify_tokens%` rows from every backup (PLAN.md:1298), so
the copy has no token row and the rehearsal skips the one step that decides whether Rem stays signed in.
Fix: T12 inserts a synthetic token row (a dummy grant, never a real one) into the copy before the run.

**L2. Key rotation breaks restores for four days, and losing the key costs more than a sign-in.** §12.3
rotates `TOKEN_KEYS` within five days of each friend's deletion and drops the old key
(PLAN.md:1540-1543), while §12.4 says the app database's backups keep the ciphertext so "a restore keeps
everyone signed in" (PLAN.md:1561-1562). Every app-database backup taken before a rotation holds blobs
under the dropped key, so for four days after each rotation a restore leaves every user without a token.
"Losing the key costs every user one sign-in and nothing else" (PLAN.md:551-552) leaves out that
closed-app capture stops for everyone until they sign in, which for a friend who does not open the app
that day is every play past their last 50. Fix: take an app-database backup right after each
re-encryption, and state both consequences in §5.3 and §12.4.

**L3. The twelve-month clock is a sign-in clock.** Deletion after twelve months keys on
`users.last_sign_in` (PLAN.md:331, 1478-1481). That tracks use only because sessions are a fixed 30 days
and never renewed (PLAN.md:573). The day someone makes sessions renew on use, an active friend stops
producing sign-ins and is deleted at month twelve. Fix: key the rule on a last-seen stamp written at most
daily from the identity read, or pin the coupling with a test that names the deletion rule.

**L4. Two of Phase 3's exit checks read data nothing records.** Phase 3 exits on "the open app harvests
only catch-ups" and "no play is first stored by a backstop while Rem was listening" (PLAN.md:1586; the
second also answers an unknown, PLAN.md:1875). `plays` has no insert time or source (`db.ts:168-175` and
its later `ALTER`s), and the plan does not tag harvests by trigger, so neither check can be read off the
store or `api_log`. Fix: each harvest logs its trigger in `api_log.source` (`harvest:change`, `:tail`,
`:retry`, `:completeness`, `:backstop`, `:open-app`), and the soak reads that.

**L5. The foreign-play cleanup leaves copies.** §11.2 deletes the incident's plays from the live database
after lane 1904 (PLAN.md:1346-1369). The same rows, and any `contexts` names resolved with the second
account's token, stay in every nightly backup from Oct 15 until the delete (60 days on OneDrive), in the
cutover's snapshot and in lane 1909's archive. `client_metrics` may hold `handoff` rows naming that
account's songs ("artist — title", 01a §2), and its prune has not run since August
(STORE_MIGRATION §3). The second
account's grant also stays valid at Spotify until its owner removes the app (01e §1.6). Fix: name these
copies in §11.2 with when each ages out; delete the window's `handoff` rows; if Rem knows who the second
account was, ask them to remove Lazy Boy at spotify.com/account/apps.

**L6. Phase 3 changes Rem's own app weeks before any friend, outside §18.** Phase 3 ships to Rem alone:
now-playing polls every 15 s mid-track instead of 6 s (PLAN.md:939-943); `refreshHistoryAction` stops
harvesting, so at a track change the stored row arrives up to ~2 minutes later behind the provisional
one (PLAN.md:934-938); the cron's idle backstop goes from hourly to every two hours (PLAN.md:887); the
Liked safety-net refetch from daily to weekly (PLAN.md:954-956). Each exists to share Spotify's budget
with friends who will not exist for weeks; each is small; none is in §18. Fix: list them in §18 for
Rem's yes, or switch them on with the second active user. Re-run `tests/handoff.test.ts` at the 15 s
cadence, since the instant handoff reads the chip's last poll.

**L7. Decision 8 states its benefit and not its cost.** It recommends the single-user track (P2, then
P3) before Phase 1 (PLAN.md:1971-1974), and §13.3's date for the first friend, early to mid-December,
follows from that order (PLAN.md:1628-1631). By the plan's own durations (P2 a few days, P3 one to two
weeks) the order moves the first friend back by about one and a half to two and a half weeks [estimate].
P3 alongside Phase 1 is ruled out by "one lane in `db.ts` at a time" (PLAN.md:1621), so this is a real
trade between the friend's date and merge risk, and decision 8 should say so.

## 2. What holds up

(to be filled)

## 3. What I ran

(to be filled)
