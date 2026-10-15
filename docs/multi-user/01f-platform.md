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
### 2.2 The limits that matter on that plan
### 2.3 Today's usage against them, and the per-user growth
### 2.4 Where multi-user meets a Vercel limit first

## 3. The Zenbook: sqld behind a Tailscale Funnel, a single point of failure

### 3.1 What runs there
### 3.2 What fails today when it is down, path by path
### 3.3 How often it is down
### 3.4 The Funnel's own limits and the certificate
### 3.5 What multi-user changes about it

## 4. The planned Turso move

### 4.1 What STORE_MIGRATION does, and when
### 4.2 Turso's plans and prices today
### 4.3 Usage per user per month, from the meter
### 4.4 Where each plan runs out
### 4.5 What multi-user needs from STORE_MIGRATION, and what should change before it runs

## 5. Costs at 5, 25 and 250 users

### 5.1 The per-user assumptions
### 5.2 The options, priced
### 5.3 The table

## 6. Decisions that are Rem's

## 7. What I ran, and what I did not measure
