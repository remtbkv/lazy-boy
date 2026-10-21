# Multi-user Phase 4a, built ahead of its turn

Lane 1945_lb_mu_06_p4a_build, Oct 16, 2026, branch `mu/phase4a`, cut from `mu/phase3` at `f754f72` (lane 05's
reviewed head). Nothing here is merged, pushed or deployed. Nothing touched production data, Spotify, Turso,
Vercel, the Zenbook or the Keychain: every test runs against local database files, a scripted Spotify and a
scripted Platform API, and the one server run was `next start` on 127.0.0.1 over local files.

Status: complete for this lane. §2 is what landed, §3 what proves it, §4 what the turn (lane 19) wires and why
each waits, §5 the runbooks lanes 24, 28 and 29 need, §6 the choices made where PLAN or the rulings left one open,
§7 what I am unsure of, §8 how to review.

**Turn status (lane 19, Oct 16): wired on `mu/phase4a-turn`, replayed onto `mu/p3-base`; §10 is the account.**
Not pushed or deployed. The scopes stay as they are: the reduced-scope probe file does not exist (§10).

## 1. What this branch is

The brief limits this lane to new files and the files `mu/phase1`-`mu/phase3` changed. The branch edits, of
those, `auth.ts`, `app-db.ts`, `app-schema.ts`, `identity-read.ts`, `session-gate.ts`, `token-core.ts`,
`user-cache.ts`, `health.ts`, `sync/tick.ts`, `spotify/userinfo.ts`, `actions.ts` (Log out and Disconnect only),
the two playlists pages, the health, now-playing and playlist-tracks routes, `next-auth.d.ts`, `CLAUDE.md`, and
the tests those phases touched. Everything else is new.

One exception, flagged: `/privacy` and `/terms` are on `main` (130cb13, 98857bf) and were not on `mu/phase3`. The
branch cherry-picks both commits unchanged (6cb5003, e1726d6) and edits on top, so lane 19's rebase meets
identical content and keeps only this lane's diff. The cherry-pick also brings `/login`'s consent line and
`tests/legal-pages.test.ts`, as on `main`.

The rulings this follows (RULINGS.md): sign-up is a request form (Oct 15 12:46 PM); Log out stops capture and says
so, Disconnect removes the account (1:17 PM, 1:33 PM); a dead grant gets an explanation, never a silent redirect
(decision 20); `invalid_grant` per PLAN §5.4 with deletion on day 4, never the admin's (decision 21); friends kept
while connected, no idle pause, no 12-month deletion (decision 22); Turso free and Vercel Hobby (17-18); friends
not backed up (6:21 PM); no canary account (9:27 PM).

## 2. What is built

Numbered as the brief's items.

1. **The request form and its storage.** `APP_SCHEMA` step 2, additive (`min_reader` stays 1, so Phase 2-3 code
   still opens the database): `requests` (id, e-mail, name, status pending | approved | claimed, times, the terms
   version accepted, the uid approval made, the join token's hash), one open request per address.
   `app-db.ts createJoinRequest` is the one statement a stranger reaches, bounded in SQL: shut under
   `SIGNUPS=owner`; at most 5 new requests an hour app-wide; at most 8 waiting; none once 5 people hold places;
   e-mail required and checked, name optional ("A friend" when blank), the policy and terms accepted. It creates
   no database and calls nothing outside the app database. `/join` (`src/app/(auth)/join/`) shows PLAN §12.6's text
   as the rulings change it and the form; with a request cookie it shows only where that request stands; under
   `SIGNUPS=owner` it shows the closed notice and no form. `POST /api/join` stores and sets the request cookie;
   `GET /api/join/link?t=` is the join link. `src/lib/terms.ts` holds the terms version both legal pages show.
2. **`scripts/invite.mjs`** `--list` (refuses inside a Claude Code session, since it prints e-mails), `--approve
   <request>` (refuses at five places held; reserves the uid as `provisioning` in one transaction with the
   request's link; creates `lb-u-<uid>` in group `default`, applies `src/lib/user-schema.ts` and the four meta keys,
   checks `owner_uid`; sets `invited` and `approved` with the token's hash; prints the join link and the User
   Management reminder; on an approved request, a new link), `--revoke <uid>`, `--decline <request>`. A crash
   leaves a `provisioning` row that `--approve` resumes and `--revoke` removes. Platform token from the Keychain
   item `lazyboy-turso-platform` (`scripts/turso-mac.mjs`), never printed. The 14-day expiry is a daily chore.
3. **The claim.** `app-db.ts claimInvite`: PLAN §5.1's compare-and-set, keyed on the request the signed cookie
   names: `invited`, no `account_id`, not the admin, under 14 days, request `approved`; binds `account_id` and the
   real Spotify id, copies the terms accepted, marks the request `claimed`, in one transaction.
   `identity-read.ts resolveSignIn` claims only for an account with no row (so an existing user never claims
   anyone's invite) and only under `SIGNUPS=invite`. `auth.ts`'s signIn callback reads the cookie
   (`request-cookie.ts`: `v1.<id>.<expiry>.<HMAC-SHA256>` under a key derived from `AUTH_SECRET`, two days).
4. **`scripts/user.mjs`** `--disable` (epoch + 1) / `--enable` / `--remove` (the deletion job from the Mac, waiting
   out the lease window), each with one line in the telemetry store's `lifecycle_log`; it refuses without
   `TELEMETRY_DATABASE_URL`, and never touches the admin.
5. **Log out and Disconnect.** `src/lib/account.ts`; `actions.ts` `logout` and `disconnectAction`. Log out bumps
   `session_epoch` and deletes the token row, awaited, for anyone, Rem included; `/signed-out` says recording
   stopped, how to resume, and that the gap comes back only as far as Spotify's last 50, and clears this
   browser's stores. `/disconnect` (gated): the export (built in the browser from `/api/search/history` and
   `/api/search/library`), the typed word, a sign-in within 10 minutes by `auth_time` (now on the session as
   `authTime`; otherwise "Sign in again", `reauthForDisconnect`), never the admin, whose page offers Log out only.
   `/disconnected` sends the person to spotify.com/account/apps and clears the stores.
6. **The deletion job.** `src/lib/deletion.ts` holds the steps and their statements as data, so the runtime
   (`deletion-runtime.ts`: `app-db.ts execDeletionStatements`, which runs only those statements;
   `turso-platform.ts`, the one reader of `TURSO_PLATFORM_TOKEN` in `src/`; `telemetry-lifecycle.ts`) and
   `user.mjs` run the same SQL. Refusals first: the admin, a row not naming `lb-u-<uid>`, a database whose
   `owner_uid` is not that uid (an empty one included). Step 1 is a compare-and-set to `deleting` with epoch + 1,
   and the queue, token, lock and request rows deleted only once that landed; 2 destroys; 3 deletes the uid's
   telemetry rows and appends one lifecycle line, once (`app_meta deleted_telemetry:<uid>`); 4 is nothing to wait
   for (friends are never backed up); 5 waits out the 50-s lease window, deletes again, asserts nothing remains,
   and leaves `deleted` with uid, account_id, status and status_at. Every step resumes; a retry never resets the
   clock. `withdrawInvite` is the unclaimed-invite path.
7. **`invalid_grant`** (§5.4 steps 3-5, `src/lib/grant-policy.ts`), in the tick's confirmation: the admin, an
   app-wide event (two users or the admin in 24 h, or a `grant-wide` event in 4 days) or a grant ~170 days old
   stays `needs_reconnect`; a friend's younger one is `revoked` (keeping the first failure's `status_at`, the
   day-4 clock) with a `revoked` event. The request path now stops and keeps the same way (`token-core.ts`
   `onDeadGrant` → `app-db.ts markGrantDead`, each write guarded by `changes()` so a second failure writes nothing,
   and a per-uid memo of the dead refresh token so an open tab does not re-send it; the tick's confirmation
   bypasses the memo). This closes PHASE3.md §4 item 9. Decision 20: the playlists pages send a dead grant to
   `/reconnect`, which says what happened and what to do, then offers the sign-in.
8. **The daily chores 4a adds** (`src/lib/daily-4a.ts`, `phase4aChores()`): deletion retries; day 4 of `revoked`
   (held while a `grant-wide` event from the last 4 days stands); the 14-day invite expiry; the sweeps (`deleted`
   rows past 5 days, orphan token, queue and lock rows, requests pending past 14 days, health records past 30
   days); both cron-job.org jobs re-enabled (`cronjob-jobs.ts`, `CRONJOB_JOB_IDS`). No dormant or twelve-month
   trigger. Outcome strings carry codes, never uids.
9. **The health check.** `app-db.ts readHealth` in one batch: events not yet reported, by code, marked reported in
   the same batch so each e-mails once (isolation codes → `isolation`; `invalid-grant`, `grant-wide`, `revoked` →
   `grant`; others → `event`); `revoked` or `deleting` over a day (`deletion`); a friend `needs_reconnect` over six
   hours (`reconnect`), in backoff with no success over six hours (`backoff`), `removed` over seven days
   (`removed`); `daily_at`. Every red verdict answered is recorded as `app_meta health_red:<ms>` = its reasons
   (store failures too, as `store`). This also covers PHASE3.md §4 item 8's events read.
10. **The planted probe**: `POST /api/cron/probe`, `CRON_SECRET` only, in two calls (§5): forge, then read back
    through `userCache`; exactly one `cache-stamp` event. Two calls because inside a request Next 16 stores a new
    `unstable_cache` entry only when the request ends (`unstable-cache.js`: the miss path pushes `cacheNewResult`
    onto `pendingRevalidates`), so a read in the forging request would raise nothing. `userCache`'s stored callback
    now comes from one factory (`stamped`), so the forged entry sits under exactly the key the real read uses.
    Checked on `next start`: forge 202, read `{"ok":true,"events":1}`, a wrong bearer 401, one event row.
11. **`/v1/me`**: only a 403 is "not registered"; a 429, 5xx or 401 is `SPOTIFY_UNAVAILABLE` →
    `/login?error=SpotifyUnavailable`. The scopes: `src/lib/scopes.ts DROP_PROFILE_SCOPES` (false).
12. **Now-playing**: the per-user memo, 5 s or what is left of the song if less, with the replayed progress aged by
    the time since the sample (NOW_PLAYING_2S.md lane L0), keyed by uid, 200s only (`src/lib/now-playing-memo.ts`). The 15-second
    mid-track polling is in `now-playing-context.tsx`, outside this lane's files (§4).
13. **`/privacy` and `/terms`** true of the above: the request's e-mail and name and why; account id; tokens
    encrypted; logs tagged with the random id; a database of one's own on Turso, the accounts database there,
    Turso's one-day point-in-time history including the encrypted tokens; friends' data not backed up; the
    operator's access; the assistant sentence kept; Log out; Disconnect, the export and the five-day note; removal at
    Spotify deleted on the fourth day unless they sign in. Both take their date from `terms.ts`.
14. **Tests** below; T3's census lists every new entry point.
15. This file.

Also: `/api/playlists/[id]/tracks` takes ten calls a minute per user per instance (`src/lib/user-bucket.ts`, §6.6),
the helper the turn reuses for `searchPlaysAction` and the player actions; `CLAUDE.md`'s file map.

## 3. The tests, and what each proves

Gates at the branch head: `tsc --noEmit` and lint clean; `npm run build` passes; the three node suites pass;
vitest 922 of 924, the two failures being the date tests `mu/phase3` inherited (`store-plays` "daily stats
agree…", `sync-history` "harvests, resolves…"), which pass with `ca44438`'s fix applied for one run and restored.
Every new check was shown failing first: against the missing module or the old code, or against a mutant (one line
changed, the suite run, the line restored; 41 in all). Three survived at first (two of the claim's conditions,
the approval's unconditional request link) and each got the case it lacked; all 41 fail the suite at the head
(the first claim mutant re-run there to check).
Four planted bugs stay in `planted-bugs.test.ts`.

| file | proves | shown failing against |
|---|---|---|
| `isolation/t9-claim.test.ts` | **T9's claim half**: a pending request signs nobody in; an approved one is claimed once by the account carrying its cookie; a second account finds nothing; a bound invite whose request still reads approved, and a provisioning row, cannot be claimed; Y's cookie claims Y's invite, no cookie nothing, an existing user (or the admin) with X's cookie signs in as themselves and X's invite is untouched; `SIGNUPS=owner` writes nothing; 14 days expire; the cookie refuses unsigned, tampered, re-pointed, extended, expired and foreign-secret values | the missing modules; three mutants of the claim's WHERE |
| `isolation/join-request.test.ts` | the form's storage: normalised e-mail, filler name, terms version; shut under owner; validation; one open request per address and no cookie for a duplicate; 5 an hour; 8 waiting; closed at 5 places; no fetch | the missing modules |
| `isolation/join-routes.test.ts` | the POST's cookie (signed, HttpOnly, Lax, Secure on https) and its refusals; the 4 KB cap; the join link only for an approved, unclaimed, live invite; `/join`'s text, form and per-state views; no form under owner | three mutants (no mac check, the link ignoring status, a cookie on refusal); the closed case against the old view |
| `isolation/t11-deletion.test.ts` | **T11**: B's sessions, queue, grant, lock, request, database and telemetry gone, a refresh and a sign-in landing mid-deletion store nothing, done after the lease window, a second run a no-op, nobody else's anything moved; resumption across a Platform API and a telemetry outage; refusals (admin in every status, five wrong names, a foreign or missing `owner_uid`, unknown, invited) change nothing; `withdrawInvite`; the runner refuses other SQL | five mutants (admin, name, owner, epoch, window) |
| `isolation/logout-disconnect.test.ts` | Log out for B and for Rem: old cookies refused, no token, no Spotify call, data kept, others untouched; the page's words; Disconnect's three rules and the job run only when allowed; `/disconnected` | the missing module; four mutants (capture left on, no epoch, no admin rule, no ten-minute rule) |
| `isolation/t14-invalid-grant.test.ts` | **T14**: one friend's, confirmed 10 min on, revoked with the first failure's clock and an alarm; two users in the window, app-wide and nobody revoked; the admin never; an old grant expired; the request path stops and keeps, records once, is not re-sent, while the tick still asks; a refresh racing a sign-in keeps the sign-in's grant | the missing module and option; five mutants |
| `isolation/daily-4a.test.ts` | which uids each chore hands the job (deleting, day-4 revoked, 14-day invites; never the admin, not before day 4, no dormant or 12-month rule); the grant-wide hold; every sweep; the cron-job.org re-enable | the missing module; four mutants |
| `isolation/health-4a.test.ts` | **T15's server half**: an owner mismatch while telemetry is down is stored, turns the check red once, is recorded; each 4a condition red on its own and not inside its window or for the admin; no uid in any reply | the old route; four mutants |
| `isolation/planted-probe.test.ts` | `CRON_SECRET` only (not `CRON_SECRET_EXT`, none, wrong); two different uids; a nonce nobody forged raises nothing; one event and a red, recorded health check per run; the entry only under the probe's own wrapper | the missing route; three mutants (EXT allowed, no stamp, no owner check) |
| `isolation/invite-user-scripts.test.ts` | both scripts end to end with the claim: provisioning (schema, keys, owner), the cap, the race, crash and resume, revoke, decline, `--list`'s guard, no token printed; disable, enable, remove, the lifecycle lines, the telemetry refusal, never the admin | the missing scripts; five mutants |
| `isolation/user-schema.test.ts` | a provisioned friend database equals what `db.ts init()` builds, table and index for index | two mutants |
| `isolation/now-playing-memo.test.ts`, `isolation/user-bucket.test.ts` | one Spotify call per user per window, each user their own; failures not kept; ten tracks calls a minute per user | a planted unkeyed memo and bucket |
| `isolation/planted-bugs.test.ts` (4 added) | a claim without its compare-and-set; a Log out that leaves capture on; a deletion with no admin refusal; an unkeyed memo: each caught, each check passing over the real code | the planted bugs |
| changed: `app-db`, `entry-points`, `static`, `spotify-userinfo`, `now-playing-route`, `legal-pages`, `phase2-app-db` | schema step 2 additive; the census; S2 (`user-cache.ts` a minter, for the probe), S3's snapshot, S4's two maps; 429/5xx/401 not "not registered"; the thirteen scopes; the legal text | the old userinfo mapping; the old privacy text |

## 4. What Phase 4a's turn wires (lane 19), and why each waits

Each is in a file this lane does not edit (a queued file or one no phase changed), or is a switch the turn throws.

1. **`/usage` admin-only**, friends' telemetry aggregated by endpoint template with no playlist ids or `handoff`
   track ids (PLAN §6.2 layer 7; `usage/page.tsx`, queued).
2. **The bounds** (§6.6): `dailyStatsAction` accepts only the width the client sends (`history-actions.ts:68`,
   `den-home.tsx:379`); `searchPlaysAction` (`history-actions.ts:190`) takes ten a minute per user:
   `allowUserCall("search-plays", gate.uid, Date.now(), 10, 60_000)` from `user-bucket.ts`; the tracks route's
   bound is built here.
3. **The player-action bucket** in `actions.ts` (`playPlaylistAction`, `addToQueueAction`, `playTrackAction`,
   `playFromPlaylistAction`, `playerSetPlayingAction`, `playPlaylistTrackAction`, `resumePlaylistAction`): the same
   helper per uid. Left to the turn because lane 12 moves every action onto `requireActionUser` in the same hunks.
4. **The Premium message**: a 403 from a player endpoint says "needs Spotify Premium" (`client.ts:195`, queued).
5. **`src/lib/owner.ts` removed** with its import in `auth.ts`'s signIn callback and `tests/owner-signin.test.ts`.
   Until then the claim is unreachable in production: `isOwnerSignIn` refuses every non-owner profile first.
6. **`SIGNUPS=invite`**: an environment change (lane 29). The identity read, the claim, the cron's claim and
   `/join` already obey it; under `owner` nobody can even store a request.
7. **The brake on** (`brake.ts BRAKE_ON = true`) and **the backstop at 2 hours** (`tick.ts PHASE3_TICK.backstopMs
   = 7_200_000`): Phase 3's constants, which the turn flips when 4a deploys.
8. **Now-playing at 15 s mid-track** in `now-playing-context.tsx` (`POLL_MS`, line 76), beside the memo here.
9. **The daily chores**: `phase4aChores()` added to `/api/cron/daily`'s list (lane 1901's route, on `main`) and run
   from the tick's `dailyChores` when `daily_at` is stale; `TickDeps.dailyChores` is the hook.
10. **Telemetry**: `api_log` and `client_metrics` gain `user_id` (Phases 1 and 3's turns); until then the deletion's
    telemetry step finds no column and deletes nothing, correctly. `telemetry-lifecycle.ts` builds its own client
    from `TELEMETRY_DATABASE_URL` (or the one store); the turn may hand it `db.ts`'s `getTelemetryClient()`.
11. **The chrome** (`chrome.tsx`): a Disconnect link beside Log out, and both forms calling `clearUserStorage`
    before they submit (the pages after them clear too).
12. **`login-error.ts`**: wording for `SpotifyUnavailable` ("Spotify didn't answer; try again") and the claim's
    refusals (`signInRefusalMessage` exists). **Home and `getSpotify()`** send a dead grant to `/reconnect` instead
    of `/login` (`home/page.tsx`, `session.ts`).
13. **`/api/metrics`** refuses reserved event names such as `isolation` (T15's client half; queued).
14. **The scopes**: `DROP_PROFILE_SCOPES = true` only if `~/.claude/broke/scratch/lazyboy_mu/probe/me_keys_reduced.json`
    exists with `has_account_id` true. It did not exist when this lane ran.
15. **`user-schema.ts` against lane 12's versioned open**: if Phase 1's turn puts a `USER_SCHEMA` in `db.ts`, this
    list becomes its version 1 and the `schema_version` value written into friends' meta must match it.
16. **The Zenbook backup change** (lane 19's item 3, RULINGS 6:21 PM): friends' databases never dumped, any backup
    file of a non-admin database pruned first at any age, `lazyboy-app` and telemetry copies filtered to the admin's
    rows (and NULL uids for telemetry). `/privacy` already says friends are not backed up, so this must ship with
    4a.
17. **Production environment** (lane 24): `TURSO_PLATFORM_TOKEN` (Production only, decision 24); `TURSO_ORG` if not
    `remtbkv`; `CRONJOB_API_KEY` and `CRONJOB_JOB_IDS` (the pinger's and the health job's ids).
18. **Docs**: SECURITY.md's deletion and invite runbooks, README's inviting a friend (§5), ARCHITECTURE.md.

## 5. Runbooks

**A friend joins** (Rem): they request at `/join` (only once `SIGNUPS=invite`); `node scripts/invite.mjs --list`
in his own terminal; add the e-mail in the Spotify dashboard's User Management; `node scripts/invite.mjs --approve
<request id>`; send the printed link (`/api/join/link?t=…`, 14 days); they connect. A friend leaves:
Disconnect, or `node scripts/user.mjs --remove <uid>` with `TELEMETRY_DATABASE_URL` and `TELEMETRY_AUTH_TOKEN` in the
shell.

**The planted probe** (lanes 28 and 29), with the Zenbook's `CRON_SECRET` in the environment of the command:

```bash
N=$(curl -s -X POST "$ORIGIN/api/cron/probe" -H "authorization: Bearer $CRON_SECRET" \
      -H 'content-type: application/json' -d '{"uid":"<Rem uid>","stamp":"<a uid no row holds>"}' \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["nonce"])')
sleep 2
curl -s -X POST "$ORIGIN/api/cron/probe" -H "authorization: Bearer $CRON_SECRET" \
     -H 'content-type: application/json' -d "{\"uid\":\"<Rem uid>\",\"nonce\":\"$N\"}"   # {"ok":true,"events":1}
```

The next hourly health check answers 500 `["isolation"]` and cron-job.org e-mails Rem; the proof it went out is the
record, an aggregate (RULES 11): `SELECT key, value FROM app_meta WHERE key LIKE 'health_red:%' ORDER BY key DESC
LIMIT 5`, whose key is the time in ms and whose value includes `isolation`. The event row is marked reported, so
the hour after is green again.

## 6. Choices made where PLAN or the rulings left one open

- **The invite has no Spotify id until it is claimed.** The ruling's form takes an e-mail, and development mode
  returns none, so nothing the app sees links a sign-in to a request except the cookie. `users.spotify_id` is
  `NOT NULL` with a unique open-invite index, so an invite holds `invite:<request id>` until the claim writes the
  real id. Consequence, stated: a person holding X's cookie or link who is also on Spotify's allowlist with no row
  of their own could claim X's invite. Only accounts Rem added can sign in at all, an existing user never claims,
  Phase 5 adds friends one at a time, and the claim is single-use, so the window is one unclaimed allowlisted
  account at a time, which is normally X. Binding it tighter needs something of X's that Spotify returns in
  development mode, and nothing does.
- **The form's limits**: 5 requests an hour app-wide, 8 waiting, closed at 5 places held (every row not
  `deleted`), one open request per address, and no cookie for a duplicate (a known address must not hand out a
  capability). A stranger can fill the 8 waiting places in about two hours; `--decline` clears them and pending
  requests expire after 14 days.
- **The request cookie lasts two days**; the join link 14 (the invite's life) and can be opened again.
- **Disconnect's word is "disconnect"**, not the display name PLAN §5.4 suggests: display names can hold
  characters a keyboard does not type easily, and the word's job is to make the act deliberate.
- **`revoked` keeps the first failure's `status_at`**, so `status_at` is the day-4 clock even when the confirmation
  ran late. Day 4 means three full days after the first failure, so a missed daily run still deletes inside five.
- **A `grant-wide` event stands for four days** against any automatic deletion.
- **The request path stops and keeps for everyone, Rem included**, matching the tick; his grant dying is
  `needs_reconnect` and the owner alarm, never deletion.
- **The deleted row** keeps uid, account_id, status and status_at; `spotify_id` becomes `''` and `db_name`
  `deleted:<uid>` (both `NOT NULL`, one `UNIQUE`). The request row is deleted with the account (it holds the
  e-mail); a claimed request is kept while the account lives, so `--list` can name whose uid is whose.
- **Places counted** as every users row not `deleted` (the brief says active plus invited): a disabled or
  reconnecting friend still holds a User Management slot.
- **The health check marks events reported when it reads them**, so a manual call by a lane consumes them; the
  `health_red` record keeps the evidence.

## 7. What I am unsure of

- The probe's two calls are proven on `next start` with the file-system cache; Vercel's Data Cache is shared
  across instances and should behave the same, but only lane 29's production run shows it.
- `changes()` in `markGrantDead` is checked on local SQLite; sqld runs a batch's statements in order on one
  connection, so it should hold over Hrana, unverified there.
- The `after()` retry in `disconnectAction` sleeps 52 s; on Hobby that may outlast the function, in which case the
  daily chores finish the deletion within a day (the health check turns red if one is still `deleting` after 24 h).
- The deletion's day-five backup check (PLAN §12.3 step 4) is not built here: friends are never backed up, and the
  backup script's own check that no file names a departed user's database is lane 19's.

## 8. How to review

```bash
git worktree add ~/projects/lazyboy-wt/<yours> mu/phase4a && cd ~/projects/lazyboy-wt/<yours>   # node_modules per RULES 5
git log --oneline mu/phase3..mu/phase4a
npx vitest run tests/isolation tests/legal-pages.test.ts tests/spotify-userinfo.test.ts
npm test && npx tsc --noEmit && npm run lint && npm run build
```

Read in this order: `app-schema.ts` step 2 and the Phase 4a sections of `app-db.ts` (the form's insert, the claim,
the deletion runner, `markGrantDead`, the health read); `request-cookie.ts`; `identity-read.ts resolveSignIn`;
`deletion.ts`; `account.ts` and the two actions; `token-core.ts deadGrant`; `grant-policy.ts` and `tick.ts
confirmGrant`; `daily-4a.ts`; `user-cache.ts`'s probe; `scripts/invite.mjs`, `user.mjs`. A cross-user path would
most likely hide in: the claim (an account binding an invite that is not its own), the deletion's refusals, the
join link's lookup, and the probe's key (an entry a real read could meet).

## 9. Lane 09's review (Oct 16)

An adversarial review in a fresh context (lane 1945_lb_mu_09_p4a_review) found four defects and fixed each on this
branch with a test shown failing first:

- **`93e5ed4`, an app-wide `invalid_grant` event deleted a friend already revoked.** The verdict was taken only at
  each user's own confirmation, so a friend confirmed revoked alone stayed `revoked` when a second user's grant died
  hours later: on the request path no `grant-wide` event is written and the day-4 chore deleted them; through the
  tick the event held them four days, then deleted them. The day-4 chore now reads each due revocation's own window
  (24 h either side of its first failure) and moves one with another user's, the admin's or a `grant-wide` event
  there back to `needs_reconnect`.
- **`0bc8c4e`, the form stored control characters** (ESC, C1, bidi overrides) in the e-mail and name, which
  `invite.mjs --list` printed raw into Rem's terminal. The form refuses them in the e-mail and strips them from the
  name; the script prints any stored one escaped.
- **`30e3828`, Log out claimed success when the identity check could not run**: it signed this browser out and
  `/signed-out` said every browser was out and recording had stopped, with nothing ended. `account.ts logOutFrom`
  now throws in that case, into the `(app)` error boundary.
- **`c8fab0d`, `/privacy` promised a day-4 deletion** the code withholds for an app-wide event or a ~170-day grant,
  and did not say the five-day note keeps the Spotify account ID. Both now say what the code does.

Also `a4a87fe`: T9 pins the claim's check that the request reads `approved` (a mutant dropping it survived).

For the turn and the deploy (not defects of this branch):

- `deleteUserTelemetry` deletes nothing until `api_log` and `client_metrics` carry `user_id` (§4 item 10), while
  `/privacy` says a departing friend's diagnostic logs are deleted. Check the column exists in production before
  `SIGNUPS=invite`.
- Once Phase 1's turn moves `db.ts`'s `unstable_cache` reads onto `userCache`, a friend's payloads sit in Vercel's
  Data Cache under their uid (revalidate up to a day; how long Vercel keeps an entry nobody reads again is not
  checked). `/privacy` names Vercel only as the host that sees requests, and the deletion job purges no entry.
- `/login` still says "We only access your library to manage playlists" (from `main`), which the history capture
  makes untrue.
- PLAN §12.1's separate opt-in to account e-mails at `/join` is not built; the form's acceptance of the policy, which
  says the address is used "to tell you about your account", stands in for it.
- The stated limit of §6 holds: an allowlisted account with no row carrying X's cookie or link claims X's invite and
  locks X out (lane 09 ran it). It exposes no one's data; Rem sees it at `--list`.

## 10. Phase 4a's turn (lane 1945_lb_mu_19_p4a_turn, Oct 16)

Branch `mu/phase4a-turn`: `mu/phase4a` (4e8fccb) replayed with `git rebase --onto mu/p3-base f754f72`, then lane 10's
`mu/ops-zenbook` doc commit (336dd38 → 75f74f0), then the wiring below. Not pushed, merged or deployed; nothing on the
Zenbook changed (the backup script was read and copied, not installed). Lane 34 lays this on lanes 15 and 17's turns.

**The replay.** The two cherry-picks of `/privacy` and `/terms` (6cb5003, e1726d6) were dropped: `mu/p3-base` already had
the same content through `main`. Conflicts, each read on both sides: `actions.ts` (Phase 1's `requireActionUser` and
`forUser` beside 4a's Log out and Disconnect), the two playlists pages (Phase 1's turn removed `canCallSpotify`, so the
dead-grant redirect moved into the gate, below), the health route (Phase 1's owner marks and telemetry isolation read
kept beside 4a's `readHealth` and the red record: `daily_at` is the newer of the two stamps, isolation is either
source), the now-playing and tracks routes (memo and bound on Phase 1's `forUser`), `auth.ts`'s imports, the census
registry, `CLAUDE.md`. Five of lane 06's tests met Phase 1's `forUser` and were adapted (0b69413).

**What was wired, by the brief's item:**

1. `/usage` (admin-only since Phase 1's turn) lists none of a friend's opens or error messages and counts them only in
   the per-page numbers, keyed by page template (00ea363). The bounds: `dailyStatsAction` answers only the width Home
   sends (`DAILY_STATS_DAYS`), `searchPlaysAction` ten a minute per user, `/api/playlists/[id]/tracks` as lane 06 built
   it; the player actions share a per-user window of thirty a minute; a 403 from any player action now reads "needs
   Spotify Premium" (the three that said "no active device" go through `playbackError`) (d537bc9). `owner.ts` removed
   with its import and test (9e0b397). `SIGNUPS=invite` needs no code past that: sign-in, the identity read, the claim
   and the cron's claim already obey it; `.env.example` documents it. The brake is on and the backstop at 2 hours
   (8cbfe3f); now-playing polls every 15 s mid-track, the error backoff keeping its 12/24/48/60 s ladder (bc0edb8).
   Also: a dead grant goes to `/reconnect` from every page and from `getSpotify()` (the gate marks the refusal
   `deadGrant`), `/login` names every refusal and `SpotifyUnavailable` (0aae63d); the account menu links Disconnect
   (5882e3e).
2. **The scopes stay.** `~/.claude/broke/scratch/lazyboy_mu/probe/me_keys_reduced.json` does not exist (the probe
   directory is empty), so `DROP_PROFILE_SCOPES` stays `false` and `user-read-email` and `user-read-private` are still
   asked for. Flip it when a dev sign-in writes that file with `has_account_id: true` (PLAN §12.1).
3. **Backups** (`ops/zenbook-backup/`, e7c29ac the deployed bytes, 4eab059 the change): the prune of every `lb-u-*` copy
   runs first, before any store is read; friends' databases are never dumped; the admin's database is named by his
   users row and checked by `owner_uid`; `lazyboy-app` keeps his rows only (an unknown table fails the copy); telemetry
   keeps his uid and NULL (and fails without `user_id`); the check reads that no file names a friend's database.
   `test_backup.py` (11 cases, in `npm test`). Lane 24 installs it with two new env variables (`README.md` there),
   before `SIGNUPS=invite`.
4. **The daily chores**: `src/lib/daily-chores.ts runDailyChores(store)`, the signature lane 17 gave it, runs the owner's
   chores and then 4a's; `/api/cron/daily` stamps `daily_at` in Rem's database and the app database; the tick passes
   `runDailyChores` and stamps the app database itself (lane 17's `tick-deps.ts`). A deletion the chores start waits
   the 50-s lease window once and finishes in the same run, so it never sits `deleting` past the health check's
   one-day alarm (6261b0c, 6a4612f, beb686d).
5. T3's census and the authz map cover every 4a entry point (ten new registry entries, all twelve principals); the
   staleLogout principal runs the real Log out, so `GET /api/auth/session` refuses a copied cookie (F3) and the P4a
   pins are rewritten to their targets (21d62d6). T11 and T14 through the real entry points:
   `tests/isolation/phase4a-routes.test.ts` (the daily route finishing and starting deletions, the real jwt callback on
   Rem's `invalid_grant`), `claim-signin.test.ts` (the claim through the real callback), `dead-grant-pages.test.ts`.
   T15: the server half is lane 06's `health-4a`, the client half `tests/metrics-route.test.ts` (reserved names
   dropped). The planted-bug self-test gains a `/usage` plant (21afc5e).
6. `/privacy` says the backups hold none of a friend's data (logs included), `/usage` shows them only in totals, and
   Vercel's cached copies (8103c1d). `/terms` needed nothing.
7. This section; `SECURITY.md`'s invite and deletion runbooks, `README.md`'s inviting a friend, `CLAUDE.md`'s map
   (c99d74f).

**Evidence.** At the head: `tsc --noEmit` 0, lint 0, `npm run build` 0 with no store variables, `npm test` 0 (vitest,
the node suites, the backup unittest). `AUTHZ_TARGET=1 npx vitest run tests/isolation/authz-` fails only the two L07
cells (lane 07's interim pinger), no P1 or P4a cell or check. Every new or rewritten check was shown failing first,
against the old code or a one-line mutant (lane 19's `mutants.log`: M1-M12 and B1b-B8b caught; B8, the prune moved
after the dumps, survived the first suite and got the case that catches it).

**Choices where one was open.** Thirty player commands a minute per user (none given; a person queueing an album stays
under it, a stuck tab reaches it in seconds). Log out also deletes the admin's plaintext token row, which Phase 2 keeps
a week and the cron's "no token" alarm still reads. Backup retention 60 days for every copy: PLAN's four days were for
copies holding friends' rows, and none does. The backup prune keys on the `lb-u-` name, never on "not the current
admin name", so a restore that renames Rem's database cannot cost him his copies. `/usage` hides a friend's opens and
error text and keeps their counts.

**Shared files touched (RULES 8):** `auth.ts` (owner guard out, a comment), `session-gate.ts`, `require-user.ts`,
`session.ts`, `account.ts`, `actions.ts`, `history-actions.ts`, `db.ts` (`getClientLoadSpeed`), `brake.ts`,
`sync/tick.ts` (two constants), `now-playing-poll.ts`, the daily and health routes, `daily-4a.ts`, `login-error.ts`, the
login and privacy pages, `chrome.tsx`, `package.json` (the backup unittest in `npm test`), `.env.example`,
`tests/isolation/{authz-harness,authz-cells,authz-registry,authz-redteam,harness,planted-bugs,static,entry-points}`,
`tests/cron-routes.test.ts`, `CLAUDE.md`, `docs/{SECURITY,GOTCHAS,NOW_PLAYING_LATENCY}.md`, `AUTHZ.md`, `README.md`.

**Left for later lanes, and why:**

- **Vercel's Data Cache keeps a friend's cached payloads** under their uid after a deletion (lane 09's note): `/privacy`
  now says so. Closing it takes a uid tag on `userCache`'s entries and `revalidateTag("u:" + uid, { expire: 0 })` in the
  deletion job's first step; Next 16's purge semantics on Vercel's cache are unverified here, so it is not built.
- **A positive control for friend cells** in the authz harness (lane 1947's note): Phase 1's `forUser` maps only
  `OWNER_UID` on this base, so a friend's own read cannot run until lane 15's directory (`forUserAt` by `db_name`) is
  under it; the stitch (lane 34) or lane 28's rehearsal adds it. `claim-signin.test.ts` already proves a friend's
  sign-in gets their own uid, row and token.
- **The health check reads `revoked` over a day as red**, so a friend waiting out days 1-4 after removing the app keeps
  the check red for three days (lane 06's condition, PLAN §7.10's wording). Lane 20 may want it to read `revoked` past
  day 4 instead.
- **Deploy (lane 24):** `TURSO_PLATFORM_TOKEN` (Production only), `TURSO_ORG` if not `remtbkv`, `CRONJOB_API_KEY` and
  `CRONJOB_JOB_IDS`, `SIGNUPS=invite` last; the backup install and its two env variables before that; check
  `api_log` and `client_metrics` carry `user_id` in production (the backup refuses a telemetry copy without it).

## 11. Stitched onto Phase 3's turn: `mu/s-p4a` (lane 1945_lb_mu_34_stitch, Oct 16, 2026)

`mu/s-p4a` is this phase's slice, `2a5e950..6fde631` (lane 06's build, lane 09's review, lane 10's Zenbook commit
and lane 19's turn), replayed with `git rebase --onto mu/s-p3`, where it meets lanes 15 and 17's turns and the
meter. `git range-diff 2a5e950..6fde631 mu/s-p3..mu/s-p4a` (`--creation-factor=100`), this section's commit
aside: 31 patches unchanged, 16 changed, 1 dropped, 2 new. Lane 10's doc commit is in the slice (`75f74f0`), with the same hunks as `336dd38`.
Each changed commit's message ends with a "Stitched onto mu/s-p3" paragraph.

- `3a67b77`: identity-read.ts imports both sides' names. `be8a8ae`: Log out is `logOutEverywhere` (epoch and
  `user_tokens` row in one batch, then the admin's plaintext copy), over lane 15's `signOutTokens`, which had no
  other caller and goes with `token-core`'s `removeTokens`.
- `eb9cb4e`: the health route reads the admin through `adminStore()`, his capture through `readCapture`, and the
  events through `readHealth` (by code, marked in one batch), so lane 15's `unreportedEvents`/`markEventsAlarmed`
  go; isolation is the app database's codes alone (lane 15 removed the telemetry read); `daily_at` is the app
  database's; the meter's two inputs stay, and health.ts's verdict takes both phases' inputs and reasons.
- `c64fc1d`: the per-user memo with the meter's floor on the replies after the Spotify call (and, from a stitch
  commit below, on the memo's reply). `1181107`: /privacy's logs line names the meter's counts and the random ID.
- `1318632`, `c99d74f`: CLAUDE.md and SECURITY.md keep Phases 2 and 3's lines with this phase's.
- `d537bc9`: history-actions.ts keeps Phase 3's store-only refresh. `00ea363`: `loadUsageTelemetry` takes the
  admin uid and still settles the budget record. `9e0b397`: owner.ts goes; S2's owner path is identity-read.ts.
- `6261b0c`, `beb686d`: `daily-chores.ts` was lane 17's; it keeps `runDailyChores(store)`, the meter's chore and
  the caller's stamp (`app_meta.daily_at` alone), and adds `runPhase4aChores` after the list. `8935194` (AUTHZ.md
  for the daily route's owner lookup) is dropped: empty once the stitched route's lookup was already in the doc.

New commits: `stitch: Phase 4a's health, probe and claim tests on the stitched admin, capture and meter` (OWNER_UID
set to the admin each suite seeds, `readCapture` mocked healthy, the meter's inputs normal; friend A's harness rows
removed before A is invited) and `stitch: a memoized now-playing reply carries the budget's floor` (red with
`minPollMs` 0 on the memo's reply).

§10's left items stand. The friend positive control in the authz harness is still to add (lane 28's rehearsal or
lane 21): lane 15's naming is now under the harness, and `claim-signin.test.ts` proves a friend's sign-in reaches
their own row and token through the real callback. Gates at the slice head: `tsc`, lint, `npm test`, build green;
`AUTHZ_TARGET=1 … authz-` passes in full. Lane 34's NOTES and OUTCOMES entry have the full range-diff.

## 12. Lane 20's review of the stitched slice (lane 1945_lb_mu_20_p4a_turn_review, Oct 16-17)

An adversarial review in a fresh context of `mu/s-p3..mu/s-p4a` (f7f09ee..3b81ae4) as it will deploy, on
`mu/rv-p4a` (lane 35 folds it in). Every defect was fixed with a test shown failing first; the commit messages say
against what. Nothing pushed; the Zenbook only read (`backup.py`'s sha256 there is `cf8f581c…`, the bytes of db306c8).

- **`4179966`, the deletion left the meter's per-user counts.** `cpu_meter` (the meter, stitched in below 4a) keeps
  a row per (day, route, uid), which `/privacy` names among the diagnostic logs a Disconnect deletes. The job's
  telemetry step looped over `api_log` and `client_metrics` only, in the runtime and on the Mac, and nothing prunes
  `cpu_meter`. Both now loop over `deletion.ts TELEMETRY_USER_TABLES`.
- **`414a641`, the backup prune missed friend files outside the per-database directories.** It removed only
  `lb-u-*` directories directly under `turso/` and `lazyboy-turso`; a friend file anywhere else (a lone file, one
  under `snapshots/` or Rem's directory, one in `lazyboy-db` or `lazyboy-backstop`) failed the nightly check and
  stayed, and a local file went through `rmtree(..., ignore_errors=True)`, which cannot remove a file, while the log
  said "removed". The prune now walks the trees the check reads. A new case pins Rem's 60 days (nothing did: a
  prune that purged every directory passed). The README's hand run read `tail -8` of a ten-line run and named the
  first line `prune others`.
- **`dbf00b0`, `/api/sync`'s loads were unbounded per user.** Each load probes `/me/player` and its lease ends with
  the step, and `SyncLoop.focus()` fires on every return to a visible tab, so a tab flipping visibility in a loop
  ran up the player bucket every user shares. Ten loads a minute per user; past that a load waits like the timer.
  `dc79279` regenerates AUTHZ.md for it.
- **`9c6c71d`, server-error rows held a friend's raw path.** `instrumentation.ts` filed `request.path`, so a friend's
  error on `/playlists/<id>` stored the playlist id in a row with no uid, which `/usage` lists for the admin and the
  backup keeps. It files Next's `routePath` template now.
- **`facba8c`, `/privacy`'s diagnostic line** named page timings only; it now names the browser's error messages,
  the song-change beacon's track id, and the server's own error rows (no account's ID).
- **`c02016c`, the pages after Log out and Disconnect left the IndexedDB search copy.** `ClearUserStorage` cleared
  local and session storage only; Disconnect's form clears nothing first, so a departed friend kept every play in
  that browser. It calls `clearThisBrowser` now.
- **`f60f1dc`, a test for `/usage`'s admin check.** The authz map's friends run under `SIGNUPS=owner` (the harness
  sets none), so `requirePageUser` refuses them first and deleting `if (!user.admin) notFound()` left every suite
  green. `usage-admin-only.test.ts` gives the page a friend's gate.

Checked and holding: `/usage` is the only admin view and 404s a non-admin before any read; the cron replies carry
codes and counts; `SIGNUPS=owner` refuses a friend at sign-in (no write), at every request (the identity read) and at
the claim, the open app's claim and the grant confirmation (`ACTIVE_LEASABLE`); `invite` admits only an approved
request's claim; the brake's N is `ACTIVE_LEASABLE`'s count; every per-user bound keys on the uid; `owner.ts` and
`me_id` at sign-in are gone, `getMeId` reads only a user's own database, `PRIMARY_DB` maps a name to a URL and
`scripts/script-user.mjs` refuses anyone but `OWNER_UID` (scripts stay admin-only, fail-closed). Mutants: 8 on
`backup.py`, 13 on the app, all caught (M1 only after `f60f1dc`): lb_20/mutants.log.

Left, not defects of this slice: the authz map has no friend admitted under `SIGNUPS=invite` (lanes 19 and 34's
"positive control", lane 28's rehearsal); `events` rows naming a deleted friend's uid and the lifecycle line stay
after day five (a random id no row links to a person by then); `turso-platform.ts` says it is the only reader of
`TURSO_PLATFORM_TOKEN` in `src/`, but `/usage`'s `liveCounters` reads it too (admin-only, main's code); the health
check is red through a revoked friend's days 1-4, as PLAN §7.10 words it.
## 13. Lane 21's review of the whole multi-user diff (Oct 16-17)

An adversarial review of `1eac835..mu/s-p4a` (Phase 1, the meter, Phases 2, 3 and 4a as stitched) in a fresh
context, told to find a cross-user path or a departed friend's data kept past five days. No request, cache entry,
job or script was found to show or change one user's data for another on this stack (the class table, the
entry-point trace and the two-user paths are in `lb_21/NOTES.md`). Copies of a departed friend were found in five
places, each a guarantee one slice relied on that another slice changed; each is fixed on `mu/rv-whole` with a
test shown failing first:

- **The meter's `cpu_meter`** (per day, route and user) was never deleted: the deletion's telemetry step listed
  api_log and client_metrics, written before the meter existed. It now deletes from every telemetry table with a
  `user_id` column, found when it runs, in both runners (`e237b3f`).
- **Late telemetry and Vercel's Data Cache**: rows written after the job's telemetry step stayed, and every
  userCache entry stayed under the uid (`revalidate` marks an entry stale, and a stale entry is served, so PLAN
  §6.2's "expire within 24 hours" did not hold). Entries carry a `u:<uid>` tag; every daily run, for each friend
  whose `deleted` row is kept, expires the tag and deletes the uid's telemetry again (`11e01f9`, `37fa9a7`).
- **The deleted row** (the Spotify account ID) could stay up to a day past five; it is swept before day five ends
  (`79b6241`).
- **The browser**: Disconnect left the IndexedDB history and library; the pages after Log out and Disconnect
  cleared Storage only; a browser whose session ended elsewhere never cleared. Disconnect's form, those pages and
  /login clear IndexedDB too (`6486132`).
- **A `lazyboy-app` restore from a nightly copy** (the admin's rows alone since RULINGS Oct 15 6:21 PM) orphans
  every friend's database with no path to delete it; SECURITY.md's runbook says to restore from point-in-time
  history and how to hand an orphan to the deletion job (`a421f35`).

Guards for lane 35's fold: a memoized now-playing reply must equal the fresh one, field for field, since lane 13's
`u` (`mu/rv-p1` `253ea15`) meets the memo only there (`4360d78`); a census of all seventeen planted bugs, which
could each be deleted unseen (`71532f5`); the backup fixture's `cpu_meter` rows (`a6fbc38`). Thirteen mutants
aimed at these places, all caught (`lb_21/mutants.log`).

Not changed, recorded: `events` rows keep a departed uid (pseudonymous once the deleted row is swept; evidence for
§13.6); a sign-in over another user's live session without Log out leaves the previous user's stores in that
browser, keyed by their uid and never read; the daily chores' per-user heal (all-time recompute, Home payload
rebuild, PLAN §7.11 "per user") runs for the admin alone, which is a friend's correctness, not isolation.
