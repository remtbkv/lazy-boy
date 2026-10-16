# Multi-user Phase 4a, built ahead of its turn

Lane 1945_lb_mu_06_p4a_build, Oct 16, 2026, branch `mu/phase4a`, cut from `mu/phase3` at `f754f72` (lane 05's
reviewed head). Nothing here is merged, pushed or deployed. Nothing touched production data, Spotify, Turso,
Vercel, the Zenbook or the Keychain: every test runs against local database files, a scripted Spotify and a
scripted Platform API, and the one server run was `next start` on 127.0.0.1 over local files.

Status: complete for this lane. §2 is what landed, §3 what proves it, §4 what the turn (lane 19) wires and why
each waits, §5 the runbooks lanes 24, 28 and 29 need, §6 the choices made where PLAN or the rulings left one open,
§7 what I am unsure of, §8 how to review.

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
12. **Now-playing**: the per-user memo, 5 s, keyed by uid, 200s only (`src/lib/now-playing-memo.ts`). The 15-second
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
