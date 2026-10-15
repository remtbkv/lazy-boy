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
daily route re-enables it (`ensureCronJobEnabled`, `src/lib/cronjob.ts:14-48`). Known answers for each
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

(to be filled)

### Low

(to be filled)

## 2. What holds up

(to be filled)

## 3. What I ran

(to be filled)
