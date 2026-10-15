# 01f — The platform: Spotify's developer policy, Vercel, the Zenbook, Turso, and what each costs

Lane 0221_lb_mu_ov_platform of the multi-user planning program, written 2026-10-14. Planning only:
nothing here changed code, data, the Zenbook store or Vercel. Line numbers are against the commit
this file was first written on (`bca1713`); every vendor quote carries the URL it was fetched from
and the fetch time, and every number says how it was measured or that it is an estimate.

Status: outline — sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Spotify's developer policy today

### 1.1 What was fetched, and what could not be

Every page below was fetched with `curl -L` (desktop Chrome user agent) on 2026-10-14 between
9:12 and 9:14 PM Eastern, HTTP 200 unless noted, converted to text, and quoted verbatim.

| page | URL | dated |
|---|---|---|
| Quota modes | https://developer.spotify.com/documentation/web-api/concepts/quota-modes | undated |
| Rate limits | https://developer.spotify.com/documentation/web-api/concepts/rate-limits | undated |
| Apps | https://developer.spotify.com/documentation/web-api/concepts/apps | undated |
| February 2026 dev-mode migration guide | https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide | Feb 2026 |
| Blog: Update on Developer Access and Platform Security | https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security | posted Feb 6, 2026, update Mar 9 |
| Blog: Updating the Criteria for Web API Extended Access | https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access | Apr 15, 2025 |
| Web API changelogs, Feb / Mar / May / Jul 2026 | https://developer.spotify.com/documentation/web-api/references/changes/july-2026 (and `february-2026`, `march-2026`, `may-2026`) | per page |
| Developer Policy | https://developer.spotify.com/policy | "Effective as of 15 May, 2025" |
| Developer Terms | https://developer.spotify.com/terms | "Version 10, effective as of 15 May, 2025" |
| Spotify URIs and IDs | https://developer.spotify.com/documentation/web-api/concepts/spotify-uris-ids | undated |
| Get Current User's Profile, Get Recently Played Tracks | https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile, `.../get-recently-played` | undated |

Could not be read: `https://developer.spotify.com/blog` (the index answers 404 at that path; the
two posts it would list were fetched directly), and the community thread the migration guide links
(`community.spotify.com/t5/Community-Prep/February-2026-Spotify-for-Developers-update-thread/m-p/7330564`,
HTTP 200 but rendered client-side, so the HTML carries no post text). Nothing below relies on either.

### 1.2 Development mode: the allowlist and what it blocks

**The cap is five users, not 25.** From the quota-modes page:

> "Up to 5 authenticated Spotify users can use an app that is in development mode — so you can share
> your app with beta testers, friends, or with fellow developers who are working on the app. Each
> Spotify user who installs your app will need to be added to your app's allowlist before they can
> use it."

The February 2026 post announced it ("Each Client ID will be limited to up to five authorized users")
for new apps from Feb 11, and its Mar 9 update applied it to existing ones: "The Spotify Premium
requirement, the authorized user cap and one Client ID per developer limit will take effect as
planned for existing Development Mode integrations." The migration guide adds the one exception:
"Existing apps are grandfathered: If you already have multiple Client IDs or more than 5 users, you
will retain them. These limits only restrict what you can create or add going forward."

Three consequences for this repo:

- `docs/SECURITY.md` ("Before production — checklist") still says dev mode "caps to 25 allowlisted
  users". That is stale. The 25 on today's pages is the *Client IDs per developer* limit (July 2026
  changelog: "Client IDs per developer — Increased from 1 to 25"), not users. The planning program's
  design brief carries the same error ("users: 25 under Spotify's development mode",
  `~/.claude/broke/scratch/lazyboy_mu/make_mu.py`, `DESIGN`): **the design lanes should plan to 5.**
- No fetched page says whether the owner counts toward the five. The wording ("Up to 5 authenticated
  Spotify users can use an app") counts users of the app, and Rem is one, so plan on Rem plus four.
  Unverified; the dashboard's User Management tab is the authority.
- Grandfathering keeps only accounts already on the list on Mar 9. Whether this app has more than
  five is visible only in the dashboard. The app behaves as a post-February app (the `/tracks`
  playlist endpoints 403 here, `docs/GOTCHAS.md` "Spotify Web API — changed since model training
  data"), but the Mar 9 update postponed endpoint changes only for existing apps, so this is weak
  evidence of when the app was created, not proof. Rem can read both facts off the dashboard in a
  minute.

Two more dev-mode rules that bind every user at once:

- "The app owner must have a Spotify Premium account for apps in development mode to function"
  (quota-modes), and the migration guide: "If the owner's Premium subscription lapses, the app will
  stop working." Rem's subscription is a dependency of every account on the app.
- An account that is not on the list can complete sign-in, and then "API requests with an access
  token associated to that user and app will receive a 403 status code error" (quota-modes). That is
  the 2026-10-14 production error `src/lib/spotify/userinfo.ts` now handles (GOTCHAS, "Sign-in by an
  account outside that allowlist").

What dev mode blocks, relevant to multi-user features (migration guide, "Other User Data (Removed)"):
`GET /users/{id}` and `GET /users/{id}/playlists` are gone with "No replacement", and "Playlist
contents (items) are only returned for playlists the user owns or collaborates on." Any friends
feature (compare, subtract, shared stats) cannot read another person's data from Spotify. It can only
work from data the app itself holds, with each friend signed in under their own token. Multi-user
support is therefore the precondition for the friends roadmap, and it has to be built on the app's
own store.

### 1.3 Extended quota mode: what it requires, and whether lazyboy can qualify

It cannot qualify. The quota-modes page:

> "Please note that as of May 15th 2025, Spotify only accepts applications from organizations (not
> individuals)."

> "Implementation requirements: Established Business Entity (legally registered business or
> organisation); Operating an active, and Launched Service; Maintaining a minimum of active users (at
> least 250k MAUs); Being available in key Spotify markets; Commercial Viability; Adherence to Terms"

and "This review process can take up to six weeks." The April 2025 post frames the bar: extended
access "will be reserved for apps with established, scalable, and impactful use cases that help drive
our platform strategy forward and promote artists and creator discovery." The February 2026 post is
explicit about what dev mode is for: "personal projects for non-commercial use by individual
developers", and "It is intentionally limited and should not be relied on as a foundation for
building or scaling a business on Spotify."

lazyboy is one individual's personal project. 250,000 monthly active users is a thousand times the
largest tier this program asks about. No version of this app reaches extended quota mode.

Splitting users across several Client IDs (25 apps × 5 users) is not a way around it. The Developer
Terms, Section VI: "You must use a separate Security Code for each SDA. You may not use more than one
Security Code for each SDA." (The Developer Policy, section VII, repeats it.) It would buy no quota
either: the July 2026 changelog says "API quotas for development mode are now counted per developer
account rather than per Client ID."

### 1.4 Rate limits: what Spotify publishes, what the app does, how one app's limit divides across users

Spotify publishes two separate mechanisms and no numbers for either.

- **Rate limit** (rate-limits page): "Spotify's API rate limit is calculated based on the number of
  calls that your app makes to Spotify in a rolling 30 second window. ... The limit varies depending
  on whether your app is in development mode or extended quota mode." Extended apps "have a rate
  limit that is much higher than apps in development mode".
- **Quota** (quota-modes page): "Spotify's Web API has a quota system that limits the number of
  requests made through development mode apps that belong to a single developer account. Note that
  this is different from rate limits. Endpoints are grouped into quota buckets and requests to
  endpoints in the same bucket count toward a shared limit. The specific groupings and limits are
  subject to change." When exceeded, a 429 with `"reason": "QUOTA_EXCEEDED"`.

The Terms add a usage rule: "making excessive service calls that are not strictly required for the
proper functioning of your SDA" is listed under "Improper use" (Section IV).

**What this app has measured** (my query over a local copy of last night's backup snapshot,
`lazyboy-20261014-0840.db`, `api_log`, section 7):

| | value | source |
|---|---|---|
| Spotify calls per day, Rem alone, Sep 30–Oct 13 | mean 2,116 (1,917–2,292) | `api_log`, 14 full UTC days |
| of which `/me/player` | 929/day | the `currentlyPlaying()` fallback when `currently-playing` answers 204 (GOTCHAS, "Player simulation") |
| `/me/player/currently-playing` | 805/day | the 2-min cron's player check plus the 6 s now-playing poll |
| `/me/player/recently-played` | 229/day | the harvest, gated on playback (`src/app/api/cron/sync/route.ts:121-127`) |
| library scan (`/me/playlists`, `/me/tracks`, `/v1/me/playlists`) | ~120/day | `cron-library-scan`, every 30 min |
| 429s in those 15 days | 0 (9,834 × 200, 21,780 × 204) | `api_log.status` |
| the Zenbook backstop recorder | +96 recently-played calls/day, not in `api_log` | every 15 min (`lazyboy-recorder.timer`); its `config.json` holds the same Client ID as `.env.local` (compared on the last six characters, `16b44d`) |

**The one quota this app has hit is recently-played's daily budget.** `src/lib/db.ts:2653-2667`
records six penalty episodes, Aug 12–17, every one lifting at 10:46–10:51 AM ET, "while the burst
window was never close (peak 18 calls/30s against a per-30s limit)". Bucketing the snapshot's
`api_log` the same way (quota day anchored at 14:51 UTC, as `getRecentlyPlayedQuotaWindows` does):
the ban landed after **629, 635, 645, 656, 671 and 700** logged calls on Aug 11–16, plus the
recorder's ~96 on the same Client ID, so the real budget was roughly **725–800 calls per quota day**
for the whole app. Since the harvest gate shipped (Aug 17) the logged count has sat at 20–403 a day
and there has been no 429 on that endpoint.

**How that divides across users is the largest unknown in this plan.** The quota-modes text says the
quota "limits the number of requests made through development mode apps that belong to a single
developer account", which reads as one pool for every user of the app. No page says per user, and
nothing here has measured a second user. Under the documented reading:

- recently-played: at today's gate a Rem-like user costs ~229 + 96 (recorder) ≈ 325 calls/day, so
  the ~725–800 budget holds **two** such users. Five need the harvest down to ~145 calls per user per
  day, under half of today's, or a cheaper trigger (for example, harvest once per ~40 played tracks,
  counted from the player poll, since the endpoint holds the last 50: `docs/GOTCHAS.md`
  "`recently-played` only returns the last 50 plays").
- the player endpoints: ~1,734 calls/day per user (`cron-player-check`, 25,580 over 15 days) in a
  bucket whose budget nobody has measured. Five users is ~8,700/day.
- the 30-second rate limit: the cron tick would call the player endpoint for every user in the same
  second unless it spreads them; at 5 users that is 5-10 calls per tick against an observed safe
  peak of 18 per 30 s. It matters at 25 users and up, which dev mode does not allow anyway.

If the quota turns out to be per user, none of these bind at five. The cheap way to find out is in
section 6.

The client's backoff is already built for one pool: a 429 sets one module-scoped cooldown for every
request in the instance (`src/lib/spotify/client.ts:43-48`), and a ban over 120 s is persisted to the
one global `meta.spotify_cooldown_until` key (`client.ts:170-186`, `db.ts:2376-2390`). That is right
for a per-account quota bucket and wrong for anything per user. The sync overview (01c) owns the
detail.

### 1.5 Terms that bind a multi-user build (storage, retention, deletion, display)

These apply today, with Rem as the only data subject. With other people's data in the store they
start to have someone to protect. Each is quoted from the Developer Terms (Version 10) or the
Developer Policy (15 May 2025).

- **Disconnect and delete within five days.** Data Protection Appendix §5: "You shall allow Data
  Subjects to disconnect their Spotify-provided account by providing an easily accessible and usable
  mechanism ... If a Data Subject disconnects accounts ... you shall discontinue accessing the
  applicable Spotify Personal Data and delete the applicable Spotify Personal Data in your possession
  or control within five (5) days." The nightly backups keep 60 days on OneDrive and 14 locally
  (`docs/quota-forensic/BRIDGE.md`, "The nightly snapshot"), so per-user deletion has to reach the
  backups, or the backups have to be per user, before anyone else's data is in them.
- **A privacy policy and an end-user agreement before sign-up.** Section V: "You must display a
  privacy policy to end users before they install or signup to your SDA", and "You must display and
  require end users to agree to an enforceable end user agreement" with listed minimum terms
  (disclaimers, Spotify as third-party beneficiary). Neither exists in the repo.
- **Security, including the vendors.** Section V: "industry standard security and protections for any
  Spotify Content (including Spotify Personal Data) in your possession and/or control. You are also
  responsible for the security measures used by third parties providing services to you" (Vercel,
  Turso, Tailscale, OneDrive). Appendix §9: report a suspected breach to `security@spotify.com`
  "without undue delay (and in any event within twenty-four (24) hours)".
- **Storage of Spotify Content.** Section IV: "you may not store, aggregate or create compilations or
  databases of Spotify Content, other than as strictly necessary to operate your SDA. ... Do not store
  Spotify Content indefinitely." The listen history is such a database, kept indefinitely by design.
  My reading: defensible for one person's own history; weaker as a store of several people's. A
  retention statement in the privacy policy is the least the terms ask for. This is a judgment, not
  legal advice.
- **Derived listening metrics.** Policy III lists as prohibited: "Do not analyze the Spotify Content
  or the Spotify Service for any purpose, including without limitation, creating new or derived
  listenership metrics, benchmarking, functionality, usage statistics, user metrics, or building
  profiles of users". Listened time, skip verdicts, per-day and all-time stats (`src/lib/skip-rule.ts`,
  `alltime_stats`) are derived listenership metrics on a plain reading. The risk exists now; showing
  them to other users, or comparing friends, makes it larger. Rem's call; flagged, not resolved.
- **No commercial use at all.** The Terms define Streaming as including "using the Spotify Platform to
  control a background Spotify application", which the queue, play, resume and skip actions do, so
  lazyboy is a Streaming SDA. Policy IV: "commercial uses are not permitted for SDAs" except limited
  ones for Non-Streaming SDAs, and the examples include "sale of access". Friends cannot be charged to
  cover hosting. Donations are not addressed by Spotify's pages (Vercel's Hobby terms say "Asking for
  Donations does not fall under commercial usage", section 2.2).
- **Link accounts by `account_id`, not `id`.** May 2026 changelog: "Use account_id rather than id when
  linking user accounts to your service, as it is stable and will not change over the lifetime of the
  account." The profile reference on `id`: "Do not use this field for account linking — use
  account_id instead, which is immutable." Today the owner guard compares `profile.id`
  (`src/lib/auth.ts:346`, `src/lib/owner.ts:10-13`) and the store keeps `me_id`. A per-user key should
  be `account_id`; the auth overview (01e) owns the migration.
- **No e-mail from Spotify.** `email` is deprecated on `/me` (profile reference) and removed for
  dev-mode apps (migration guide, "User (from GET /me)": "country, email, explicit_content, followers,
  product"), and Section V forbids e-mailing users without consent obtained elsewhere. Account notices
  (a dead token, a deletion confirmation) have to appear in the app.
- **Roadmap items the policy rules out**, for the record: "Do not use the Spotify Platform or any
  Spotify Content to train a machine learning or AI model or otherwise ingest Spotify Content into a
  machine learning or AI model" (Policy III) bears directly on the roadmap's AI playlists.

### 1.6 What this means for multi-user

1. **One Spotify app serves at most five accounts, Rem included**, unless the dashboard shows a
   grandfathered list. Every design should target five. "25 users" and "250 users" do not exist on
   this app under today's policy.
2. **Extended quota mode is unreachable** (organizations only, 250k MAU). Past five, the only
   policy-clean path is for each person to run their own copy with their own Spotify developer app,
   which needs their own Premium; the README's "Deploy with Vercel" button already supports that
   shape. It gives up anything shared between users. Section 5 prices it.
3. **Spotify calls are likely the scarcest per-user resource at five users**, ahead of any database or
   Vercel limit, if the documented per-developer-account pooling holds. Today's harvest rate fits about
   two Rem-like users in recently-played's daily budget.
4. **Deletion within five days, a privacy policy and an end-user agreement are preconditions** for
   inviting anyone, alongside the security work in 01e.
5. **Rem's Premium subscription and the app's standing are shared fate.** A lapse, or enforcement
   action against the app (Terms IX: "revoking your Security Codes, disabling your SDA"), takes every
   user down at once.

## 2. Vercel

### 2.1 Which plan the project is on, and how that was determined

**Hobby.** Read-only REST calls with the Mac's Vercel CLI token (section 7):
`GET /v2/teams/team_omHOXItW1PXTC6XJ6WBBv16M` returns `billing.plan = "hobby"`, `status = "active"`
(team "remtbkv's projects"). `GET /v9/projects/prj_UA3749Btv0RiQPwuymee4MdZZ7HA` (`lazy-boy`)
returns fluid compute on, `functionDefaultRegions: ["iad1"]`, `functionDefaultTimeout: 300`, memory
type `standard`, and one cron, `/api/cron/sync` at `0 7 * * *` (`vercel.json`).

The Hobby allowances are per team, and this team runs other projects. The usage API's per-project
breakdown names `monitor`, `website` and `cheffing` next to `lazy-boy`; on 2026-10-13, `monitor` was
65% of the team's function invocations and `lazy-boy` 31%. Every number in 2.2 is shared with them.

### 2.2 The limits that matter on that plan

From https://vercel.com/docs/plans/hobby (fetched 9:17 PM; "Last updated September 14, 2026"),
per month:

| resource | Hobby included |
|---|---|
| Function Invocations | First 1,000,000 |
| Active CPU | 4 CPU-hrs |
| Provisioned Memory | 360 GB-hrs |
| Fast Data Transfer | First 100 GB |
| Fast Origin Transfer | First 10 GB |
| CDN Requests | First 1,000,000 |

What happens past one: "In most cases, if you exceed your usage limits on the Hobby plan, you will
have to wait until 30 days have passed before you can use the feature again." For Active CPU or
invocations that means every user's site is down for up to a month, a harder failure than Turso's,
which resets on the 1st (section 4.2).

The rest that bears on this app:

- **Cron** (https://vercel.com/docs/cron-jobs/usage-and-pricing, "Last updated July 15, 2026"):
  "Hobby accounts are limited to cron jobs that run once per day", and "Vercel cannot assure a timely
  cron job invocation. For example, a cron job configured as 0 1 * * * (every day at 1 am) will
  trigger anywhere between 1:00 am and 1:59 am." The 2-minute sync tick cannot live on Vercel on this
  plan; it lives on the Zenbook (section 3).
- **Functions** (https://vercel.com/docs/limits): "Maximum duration 300s (5 minutes) default and
  max"; "Memory and CPU 2 GB / 1 vCPU default and max". Response bodies: "The maximum payload size for
  the request body or the response body of a Vercel Function is 4.5 MB"
  (https://vercel.com/docs/functions/limitations).
- **Data Cache** (https://vercel.com/docs/caching/runtime-cache/data-cache): "Item size 2 MB (items
  larger won't be cached)"; "On Hobby and Pro, all projects in your team share a single cache";
  eviction is least-recently-used when the cache's storage limit is reached (the page gives no size).
  Every `unstable_cache` entry in `db.ts` lives there.
- **Logs and metrics**: runtime logs are kept 1 hour on Hobby (Hobby page). Observability queries
  are refused: `vercel metrics vercel.function_invocation.count --since 1d` answers "Observability
  Plus is required to run this query ... available on Pro and Enterprise plans."
- **Use**: "Hobby teams are restricted to non-commercial personal use only"
  (https://vercel.com/docs/limits/fair-use-guidelines, "Last updated September 14, 2026"), and "Asking
  for Donations does not fall under commercial usage." Friends using it free is personal,
  non-commercial use.

**Pro**, for comparison (https://vercel.com/docs/plans/pro-plan, "Last updated September 15, 2026";
fair-use page for rates): "$20/month Pro platform fee", "1 deploying team seat included", "$20/month in
usage credit"; then on demand, "Function Invocations $0.60 per 1,000,000", "Active CPU Starting at
$0.128 per hour", "Provisioned Memory Starting at $0.0106 per GB-hr" (iad1 is $0.128 per CPU-hour on
the function pricing page). Crons can run "Once per minute" with "Per-minute" precision, runtime logs
keep 1 day, and spend management can cap the bill.

### 2.3 Today's usage against them, and the per-user growth

`GET /v2/usage?type=requests&from=2026-09-14&to=2026-10-14` (the one usage endpoint Hobby may call;
`/v1/usage` answers "only available to Teams on the Pro or Enterprise plan", and `vercel usage`
fails with "Costs not found (404)") gives team-wide daily totals plus each project's percentage
share. Applying `lazy-boy`'s daily share to each day's total:

| over 30 days | team | `lazy-boy` (estimated from shares) | Hobby allowance | `lazy-boy` share of it |
|---|---|---|---|---|
| successful invocations | 75,220 | ~27,500 (~916/day) | 1,000,000 | 2.7% |
| function GB-hours (the API's `function_execution_successful_gb_hours`) | 23.9 | ~19.4 | 360 GB-hrs provisioned memory | 5.4% |
| outgoing bandwidth | 555 MB | ~25 MB | 100 GB | ~0% |
| errors / timeouts / throttles | 10 / 0 / 0 | – | – | – |

About 720 of the 916 daily invocations are the 2-minute cron tick (one invocation per tick, 30 an hour);
the other ~200 are Rem's own browsing, polls and syncs.

**Active CPU is the number I could not get.** No API open to Hobby reports it (the usage endpoint's
allowed types are `requests, monitoring, builds, edge, edge_group_by_project, artifacts, edge_config,
log_drains, storage_*, cron_jobs, data_cache`, and none carries CPU). An estimate, labelled as one:
19.4 GB-hours at 2 GB per instance is ~9.7 instance-hours a month, ~1.3 s of instance time per
invocation. Active CPU counts only the time code runs, not I/O waits; a cron tick is mostly waiting on
Spotify and the store, a Home render is the CPU-heavy case. At 5-25% of instance time, `lazy-boy`
uses **roughly 0.5-2.4 of the team's 4 CPU-hours a month**, before `monitor` and the rest. Rem can
read the real figure on the dashboard (team → Usage → Active CPU) in under a minute, and it should be
read before any design commits to Hobby.

Per added user, the growth that is not shared:

- the cron tick's work: one Spotify player check per user per tick (720 a day each) plus the sync when
  playing. If each user's tick is a separate invocation, +21,600 invocations a month per user; if one
  invocation serves every user, the invocation count stays flat and its duration and CPU grow instead;
- the user's own sessions: Rem's ~200 interactive invocations a day is the only measured profile;
- the user's search payloads in the shared Data Cache (2.4).

### 2.4 Where multi-user meets a Vercel limit first

In order, for Rem-like users:

1. **Active CPU**, if per-user work scales linearly from today's estimate: 4 CPU-hours holds between
   ~1.7 and ~8 Rem-like users at the two ends of the 0.5-2.4 band, less whatever `monitor` and the
   other projects use. Five users may already be over. This is the limit to measure first, because
   the penalty is a month-long outage for everyone on the team, including the other projects.
2. **The 2 MB Data Cache item cap**, per user rather than in total. The library payload is cached as
   one entry (`libraryIndexCached`, `src/lib/db.ts:1600-1612`). It was 1,638,540 B raw for Rem's
   August library of 13,464 identities (`db.ts:1409-1412`), so a user with about a quarter more
   library than that would silently stop being cached and pay a full rebuild on every fetch that
   misses the browser's ETag. Rem's library is smaller today (7,400 `playlist_tracks` rows in the
   snapshot vs 15,328 in August, BRIDGE.md). Per-user entries also share one LRU cache with the team's
   other projects. The search overview (01d) owns the sizes.
3. **Invocations**: ~1,000,000 / (21,600 + ~6,000) ≈ 36 users if every user's tick is its own
   invocation; ~160 if one invocation serves all ticks and only browsing scales. Not binding at five.
4. **Duration**: a single tick that serves every user must finish in 300 s; at today's ~1-2 s per
   user done serially that is 150-300 users, more if parallel. Not binding at five.
5. **The 4.5 MB response cap**: ~36,000 library songs per user at ~122 B each (`db.ts:1427-1429`).
   Not binding for anyone like Rem.

Pro removes the hard stops and the cron restriction for $20 a month, with the month's usage drawn
from the included $20 credit first. Section 5 estimates what each tier would use.

## 3. The Zenbook: sqld behind a Tailscale Funnel, a single point of failure

### 3.1 What runs there

The Zenbook (hostname `ASUSZenbook`, Ubuntu under WSL on a Windows host, STORE_MIGRATION §1) holds
every piece of production state and two of its schedulers. From BRIDGE.md and ARCHITECTURE.md
("The store lives on the Zenbook"), checked read-only over `ssh ubuntu` at 9:20 PM (section 7):

| unit | does | read at 9:20 PM |
|---|---|---|
| `lazyboy-sqld` + `lazyboy-meter` | the store: sqld 0.24.32 on `127.0.0.1:8092`, the meter on `:8090`, published as `https://ubuntu.tail026729.ts.net` | SQLite file 24.8 MB, sqld `wallog` 66 MB |
| `lazyboy-cron-sync.timer` | the 2-minute pinger to `/api/cron/sync`, the only closed-app capture path that runs more than daily | last run 9:21:22 PM |
| `lazyboy-recorder.timer` | backstop: recently-played every 15 min into `~/lazyboy-recorder/backstop.db`, its own token chain, Rem only | last run 9:15:08 PM |
| `lazyboy-backup.timer` | nightly 4:40 AM snapshot, integrity check, gzip, rclone to OneDrive (60 days), 14 days local | last: `2026-10-14T08:40:13Z ok ... 7439KB plays=22040` |
| `lazyboy-readmeter.timer` | samples sqld's cumulative counters every 15 min | – |

The box is up since 03:04:57 this morning (`uptime -s`), and it is shared: BRIDGE.md's file table notes
the DiveLoop units on it were left untouched.

### 3.2 What fails today when it is down, path by path

Two failure shapes behave differently. **Down** (offline, off the tailnet, or rebooting) fails a store
query within about a second: the store fetch retries a rejected connection or a 502/503/504 twice
with 250-500 ms pauses (`src/lib/store-fetch.ts:59-84`). **Frozen** (the Windows host stalls, the
socket stays open) waits out each attempt: 15 s per attempt, three attempts (`store-fetch.ts:28-29`,
fresh signal per attempt at `:50-57`), so **~46 s per query** before it fails, and serial queries
stack. Which shape an offline node presents through the Funnel relay, a fast error or a held
connection, has not been measured; if the relay holds the connection, "down" behaves like "frozen".

| path | store use | down | frozen |
|---|---|---|---|
| `/login`, `/api/build`, static assets | none (`src/app/api/build/route.ts:11-12`) | works | works |
| every `(app)` page: `/home`, `/playlists`, `/playlists/[id]`, `/friends`, `/usage` | layout `auth()` (`src/app/(app)/layout.tsx:48`), whose jwt callback reads the token row (`src/lib/auth.ts:381`); then the page's own reads | the jwt callback swallows the failed read and keeps the session (`auth.ts:382-386`), then the page's reads throw: "An error occurred in the Server Components render", which is what Rem saw on Aug 9-10 (BRIDGE.md, "Funnel cutover") | ~46 s for the token read alone, ~46 s more per serial page read, until an error page or Vercel's 300 s cut-off |
| `/api/now-playing` (every 6 s while a tab is visible) | the token read | `spotifyAccessToken()` swallows the error (`auth.ts:270-271`) and the route answers `{playing:null}` (`src/app/api/now-playing/route.ts:22-28`): the bar vanishes | each poll hangs |
| `/api/sync`, `/api/search/*`, `/api/playlists/*`, server actions | reads and writes | fail; search's fallback is the server-side search, which needs the store too | hang |
| sign-in | the owner guard reads `SPOTIFY_OWNER_ID` from env before the store (`src/lib/owner.ts:11`); the token write | succeeds: a failed token write keeps the tokens in the cookie for a later migration (`auth.ts:368-375`) | ~46 s on the write |
| `/api/cron/sync` | the token read | its 2-minute pinger runs on the Zenbook, so no tick arrives at all; the daily Vercel cron (07:00 UTC ±59 min) fails the read and answers 200 `skipped: "no token"` (`src/app/api/cron/sync/route.ts:96-112`) | same |
| error recording | `onRequestError` awaits a `client_metrics` write for each failed request (`src/instrumentation.ts:14-25`) | fails fast | adds ~46 s per failed request |
| backstop recorder, nightly backup | same box | stop | stop |

**Data loss.** None while an outage is shorter than ~50 plays of listening: the first sync after it
re-reads Spotify's last 50 (GOTCHAS, "`recently-played` only returns the last 50 plays"; 50 ≈ 3 h of
nonstop listening). Past that, plays are lost for good, because the recorder that would back them up
is on the same box. The recorder protects against everything except a Zenbook outage.

### 3.3 How often it is down

- **A daily reboot at about 3 AM.** The meter log is the best clock here: the 2-minute pinger drives a
  store request at least every ~2 min, so a longer silence means the box, the pinger or the store was
  not serving. Over its whole history, 48.5 hours from 2026-10-13 00:51 UTC, there are exactly three
  gaps over 150 s, all at the reboot: Oct 13 06:58:19 to 07:04:15 UTC (two gaps, ~6 min) and Oct 14
  07:00:18 to 07:08:05 UTC (7.8 min). That is 13.7 min, 0.47% of the window, about 3.5 hours a month.
  (Script in section 7; it reads the log and writes nothing.)
- **Host stalls**, which the meter does not see as gaps because the requests complete late: "103
  gaps over 100 s from 2026-09-14 to 2026-10-12, five of them on Oct 12" on the Windows-side monitors,
  one of which coincided with an 18.4 s first paint (STORE_MIGRATION §1).
- **Past outages**: a day and a half on Aug 9-10, from the quick tunnel's rotating hostname, a failure
  mode the Funnel removed (BRIDGE.md, "Funnel cutover").
- **A dated one ahead**: the Funnel's certificate "expires 2026-11-08 19:57 UTC and has failed every
  renewal since Oct 10" (STORE_MIGRATION §3; lane 1907 is queued to fix it). Unfixed, every request
  through the Funnel fails TLS from that minute: the whole app today, telemetry only after the move.

One overlap worth knowing: the daily Vercel cron fires at 07:00 UTC with Hobby's ±59 min precision,
and the reboot sits at 07:00-07:08 UTC. Some days the backstop tick lands in the one window the store
is guaranteed to be away.

### 3.4 The Funnel's own limits and the certificate

From https://tailscale.com/kb/1223/funnel (redirected to
https://tailscale.com/docs/features/tailscale-funnel, fetched 9:18 PM):

> "Tailscale Funnel is currently in beta."

> "Funnel can only listen on ports 443, 8443, and 10000. Funnel only works over TLS-encrypted
> connections. Traffic sent over a Funnel is subject to non-configurable bandwidth limits."

> "It is possible to frequently request a new certificate and exceed Let's Encrypt's rate limits. As a
> result, you may find yourself waiting 34 hours until you can try again."

The bandwidth limits are not published, so whether five users' payload rebuilds fit is unknown. The
cost of the hop is measured: `SELECT 1` takes 0.8 ms on the Zenbook's loopback and 40-210 ms median
(58-840 ms p90) through the Funnel, growing with the Zenbook's load (STORE_MIGRATION §1). The last
point bears on certificate repair: a retry loop that orders certificates too often can lock renewal
out for a day and a half, which is why lane 1907's runbook backs up and orders once (STORE_MIGRATION
§11).

### 3.5 What multi-user changes about it

- **Blast radius.** Every user is down whenever the Zenbook is. Today that is one person who owns the
  laptop; with friends it is everyone, at 3 AM every night and during every stall.
- **The pinger stays on the Zenbook after the move.** STORE_MIGRATION takes the user paths off the box
  (R2: a frozen Zenbook may add at most 50 ms), but Hobby cannot run a 2-minute cron (2.2), so
  closed-app capture for every user still depends on `lazyboy-cron-sync.timer`. An outage longer than
  a user's last ~50 plays loses that user's plays permanently, and only Rem has the recorder.
- **The recorder does not extend to others for free.** Backing up a friend means a second refresh-token
  chain per friend on a laptop in Rem's apartment. 01e owns whether that is acceptable.
- **The Zenbook's CPU is part of every query until the move.** The brotli incident shows how
  CPU-sensitive it is (26,436 ms vs 648 ms for the same scan, GOTCHAS "Never let the store compress
  with brotli"). Five users' payload rebuilds are five times the scans on that CPU.

Ways to take the pinger off the Zenbook, cheapest first: a second, independent pinger on cron-job.org,
the free service that ran this app's 2-minute job until Aug 10 (`.env.example`, "the every-2-min
cron-job.org pinger"; its old job still holds a stale secret, SECURITY.md), with the route skipping a
tick that lands within ~90 s of the last so Spotify calls do not double; or Vercel Pro's per-minute
cron at $20 a month. GitHub Actions was tried and dropped for multi-hour gaps (GOTCHAS, the sync
bullet). My recommendation is the second pinger for five users, and Pro's cron only if Pro is bought
for CPU anyway.

## 4. The planned Turso move

### 4.1 What STORE_MIGRATION does, and when

`docs/STORE_MIGRATION.md` moves the seven core tables (`tracks`, `plays`, `contexts`, `meta`,
`playlists`, `playlist_tracks`, `saved_tracks`) to a new Turso database `lazyboy` on the free plan in
`aws-us-east-1`, the AWS region Vercel's iad1 sits in (§4, §5). The three telemetry tables stay on
the Zenbook, as do the pinger, the recorder and the backups. Nothing runs before 2026-10-15 8:00 PM;
lanes 1901-1911 carry it (§7). The requirements that bear on multi-user: R1 (store round trip p50 ≤ 15
ms target), R2 (a frozen Zenbook slows no user request by more than 50 ms), and R4, which sizes the
free plan for **one** user: "≤ 50% of 500M rows read and ≤ 10% of 10M rows written per month",
projected from a heavy day (§2).

### 4.2 Turso's plans and prices today

From https://turso.tech/pricing, fetched 9:19 PM. The page renders with "Yearly" billing selected;
the month-to-month price is the yearly price plus the "Save" figure printed beside it.

| plan | price | databases | storage | rows read / month | rows written / month | point-in-time restore |
|---|---|---|---|---|---|---|
| Free | $0 | 100 | 5 GB | 500 million | 10 million | 1 day |
| Developer | $4.99/mo yearly ($5.99 monthly) | unlimited | 9 GB, + $0.75/GB | 2.5 billion, + $1 per billion | 25 million, + $1 per million | 10 days |
| Scaler | $24.92/mo yearly ($29 monthly) | unlimited | 24 GB, + $0.50/GB | 100 billion, + $0.80 per billion | 100 million, + $0.80 per million | 30 days |
| Pro | $416.58/mo yearly ($499 monthly) | unlimited | 50 GB, + $0.45/GB | 250 billion, + $0.75 per billion | 250 million, + $0.75 per million | 90 days |

> "Extra storage, reads, writes, and syncs beyond your plan are billed automatically once enabled, at
> per-unit rates that drop as you scale up." (pricing page)

> "In billing plans that include monthly quotas for row reads, row writes, and total storage, any
> query that exceeds these limits will result in a failure, indicated by the BLOCKED error code."
> (https://docs.turso.tech/help/usage-and-billing, fetched 9:19 PM)

> "In SQLite, the term 'row read' actually refers to a 'row scan' during statement execution."
> (same page)

The org runs the free plan with "overages disabled" (STORE_MIGRATION §3), so the second quote is the
operative one: August's block stopped every query for the rest of the month (READ_QUOTA.md, "What
'rows read' means"). Turso does not price per user. A user costs their share of the org's reads,
writes and storage, plus nothing per database: "Idle databases cost only storage".

### 4.3 Usage per user per month, from the meter

The meter on the Zenbook records sqld's own per-statement counters, the ones Turso bills on
(READ_QUOTA.md, "Measured reads"). `python3 ~/lazyboy-sqld/meter-report.py`, run read-only at 9:22 PM:

| UTC day | store requests | rows read | rows written | note |
|---|---|---|---|---|
| 2026-10-13 (from 00:51) | 11,169 | 7,564,958 | 12,064 | 5,102,733 of the reads are one `SELECT count(*) FROM plays p WHERE (p.ctx_orphan ...` — STORE_MIGRATION's own measurement of the orphan pass (§3); production traffic was ~2.2M |
| 2026-10-14 (complete) | 13,629 | 4,252,260 | 13,480 | normal production day |

On Oct 14 the history payload's plays scan was 2,244,004 of the reads in 44 runs (~51,000 rows a run
at 22,040 plays, ~2.3 rows read per play), and `INSERT INTO api_log` was 8,472 of the writes (63%).
The report's 30-day projection from those two days is 177M reads (35% of free) and 383K writes; the
Oct 14 day alone projects to ~128M. STORE_MIGRATION §3's heavy month for Rem is ~280M (56%), counting
~3 unscoped orphan passes a week at ~5.1M each.

**Per Rem-like user per month**, then:

| dimension | per user | how measured |
|---|---|---|
| rows read | ~130M (normal) to ~280M (heavy) | Oct 14 × 30; STORE_MIGRATION §3 |
| rows written, core tables only | ~130K | Oct 14's 13,480 minus `api_log` (8,472), `usage_ledger` (618) and `client_metrics`, × 30 |
| rows written, telemetry (stays on the Zenbook) | ~255K | `api_log` inserts × 30 |
| storage, core tables + indexes | ~11.9 MB at 22,040 plays and 15,859 tracks | `dbstat` over the snapshot copy: `plays` 6.07 MB, `tracks` 4.20 MB, `playlist_tracks` 1.45 MB, `meta` 0.07 MB, the rest under 0.04 MB each |
| storage, telemetry | ~12.7 MB, of which `api_log` 12.4 MB (104,942 rows, never pruned, STORE_MIGRATION §3) | same |

Reads do not scale with users so much as with each user's history. The dominant term is
~2.3 × (the user's plays) × (payload rebuilds a day); rebuilds follow plays that land, at most one per
10 minutes (the slow marker, READ_QUOTA.md fix 5), so a ceiling of 144 a day. A friend who signs up
with no history costs little at first and grows into Rem's figure at their own play rate (Rem: 114
plays a day over the last 31 days, 22,040 since 2026-05-30). Someone who imports Spotify's Extended
Streaming History (`scripts/import-extended-history.mjs`) starts at full size. The unscoped orphan pass
(~5.1M a run, O(plays × playlist members)) is the second term; lanes 1910-1911 scope it.

### 4.4 Where each plan runs out

For Rem-like users on today's code (reads at ~130-280M per user-month):

| plan | rows read | rows written (core) | storage |
|---|---|---|---|
| Free | **1.8 to 3.8 users**; the first month over 500M blocks every query, every user, until the 1st | ~75 users | ~420 users |
| Developer | 9 to 19 users included; then $1 per billion, no block | ~190 users | ~750 users |
| Scaler | 357 to 770 users included | ~770 users | ~2,000 users |

Reads bind first on every plan, by two orders of magnitude, and nearly all of it is the history
payload's full rebuild. Storage would shrink further if `tracks` (catalog metadata, the same for
everyone) were shared rather than copied per user; that is a design choice for the next phase.

### 4.5 What multi-user needs from STORE_MIGRATION, and what should change before it runs

**Nothing in lanes 1901-1911 needs to change before Oct 15, 8 PM.** The move is schema-preserving (a
snapshot imported as-is, §8 steps 4-7), so it neither helps nor blocks a user dimension. Adding one
afterwards on Turso costs about one read and one write per existing row (Turso's page: "Adding an
index to an existing table triggers a full table scan, with one read per existing row"; an `UPDATE`
reads and writes each row it modifies). At ~45,000 core rows that is under 0.5% of the free plan's
monthly writes. My recommendation is to let the move land and verify first (1903's R5 checks are
cleanest on a one-user store) and start schema work after 1904's aftercare.

What does need to change, before anyone else's data arrives rather than before the move:

1. **R4's headroom holds one user.** Rem alone projects to 35-56% of the free plan; one more Rem-like
   user can cross 500M, and crossing it blocks every user until the 1st. Either upgrade to Developer
   with overages enabled before the second user (~$5 a month; the block becomes a bill at $1 per
   billion reads), or make the history payload's rebuild cost proportional to new plays instead of
   all plays. The first is a decision for Rem (section 6); the second is design work and should happen
   regardless, because it is also what keeps search fast as histories grow.
2. **The daily usage reconciliation (phase A item 7) becomes the only view of a shared budget.** It
   writes Turso's real month-to-date usage to the ledger and alerts no one (R6). With overages on, the
   failure is money and that is enough. With overages off, a silent climb ends in an all-user outage;
   then an alert path is worth reconsidering, which R6 rules out today. Rem's call.
3. **Backups and the five-day deletion rule.** Phase D dumps Turso nightly to OneDrive and keeps 60
   days (§9, BRIDGE.md). Developer Terms Appendix A §5 requires deleting a disconnecting user's data
   within five days (1.5). Per-user deletion must reach the backups, or the backups must be split per
   user, before the first friend signs in.
4. **Database per user or one shared database.** Turso allows 100 databases on Free and unlimited on
   paid plans, at no cost per idle database. One database per user gives isolation by construction (no
   query can cross users), deletion by dropping the database, and per-user usage from Turso's own
   numbers; it costs a token or URL per user, migrations run N times, any friends feature has to read
   across databases, and the usage-check guard reads one database by name (`TURSO_DATABASE_NAME`,
   §5). Phase C's `lazyboy` database works as either Rem's own database or the shared one, so the move
   forecloses nothing. The design lanes own the choice.
5. **Telemetry staying on the Zenbook suits multi-user.** At ~255K `api_log` writes per Rem-like user
   per month, five users' telemetry on Turso would be 1.3M of the free plan's 10M writes, and 250
   users' would exceed Developer's 25M. It needs a user column for per-user Spotify attribution (01c).
6. **Phase E keys the browser cache on "the signed-in user's id"** and clears it on sign-out or a
   change of user (§10), the shape multi-user needs. The key should be Spotify's `account_id`, not
   `id` (1.5).

## 5. Costs at 5, 25 and 250 users

### 5.1 The per-user assumptions
### 5.2 The options, priced
### 5.3 The table

## 6. Decisions that are Rem's

## 7. What I ran, and what I did not measure
