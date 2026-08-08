# Metered external dependencies — inventory

For the forensic on: cost models built from client-side observation of a metered resource
whose server-side accounting was never itself measured. `[repo]` = stated in this repo's
docs/comments, with citation. `[general, verify]` = my general knowledge, unconfirmed
against the repo or the vendor; numbers I'm not confident of are "unverified," not guessed.

## 1. Turso (libSQL)

**(a)** `[repo]` `src/app/api/cron/usage-check/route.ts:21-25`: rows_read 500,000,000/mo,
rows_written 10,000,000/mo, bytes_synced 3 GiB/mo, storage_bytes 5 GiB (cited to
docs.turso.tech, route.ts:18). Exceeding **any one** blocks **every** query until the
calendar-month reset (`docs/READ_QUOTA.md:12-13`). Billed unit is rows **scanned**, not
returned (`READ_QUOTA.md:9`).

**(b)** Two channels that disagree in kind: server-side real — `/api/cron/usage-check`
calls Turso's **platform API** (`route.ts:44-69`), the actual billing counter; and
client-side modeled — `docs/READ_QUOTA.md`'s bottom-up per-query cost model from `EXPLAIN
QUERY PLAN` against a local replica copy (`READ_QUOTA.md:28-31`), the defect-class pattern
itself. The model's own conclusion: it accounts for ~half to two-thirds of measured usage,
residual **[UNVERIFIED]** (`READ_QUOTA.md:66-73`); a later platform-API reading (Aug 8)
shows rows_read overshooting the 500M block by 14M *while reads were rejected org-wide*,
mechanism unresolved (`PREREG.md:9-35`).

**(c)** Yes — `/api/cron/usage-check`, daily cron-job.org job with failure e-mail on breach
(>1.5× month-pace or >90% absolute), fail-closed on missing config
(`usage-check/route.ts:1-31`). Fired for real 2026-08-06 (`READ_QUOTA.md:230-233`).

**(d)** Every query — reads and writes — blocks org-wide until month reset
(`READ_QUOTA.md:12-13`); confirmed live 2026-08-08 (`PREREG.md:9-27`: SQL reads return
`BLOCKED: SQL read operations are forbidden`). Whole site down, not just sync.

## 2. Vercel (Hobby/free tier)

**(a)** `[general, verify]`, not stated in this repo. General shape: function
invocation/execution-time caps, bandwidth/mo, and a deployments/day cap are the usual
Hobby-plan dimensions — exact current numbers **unverified** (Vercel's compute-billing
model has changed repeatedly). **Data Cache (`unstable_cache`) per-entry size cap:
unverified** — I believe a low-single-digit-MB ceiling exists but have no confirmed figure.
Relevant because the library search payload is **1,638,540 B raw** (~1.6 MB) in one
`unstable_cache` entry (`src/lib/db.ts:1235`, measured 2026-08-06); the only ceiling the
repo names is Vercel's **4.5 MB function-response cap** (`db.ts:1244`) — not the Data Cache
entry limit, which is untested and unnamed anywhere here.

**(b)** Nothing. No code reads Vercel's usage API or dashboard; no client-side model
either — zero instrumentation, self-observed or server-confirmed.

**(c)** None found (`vercel.json` only declares the one daily sync cron, `vercel.json:1-6`).

**(d)** If a Data Cache entry silently exceeds an unverified per-entry ceiling, the
plausible failure (by analogy with the documented shape-key bug, `docs/GOTCHAS.md:237-253`)
is a silent miss/fallback that routes the read back onto Turso's primary — a Vercel-side
limit could manifest as *extra billed Turso rows*, invisible unless both counters are
watched together. Asserted as a mechanism, not confirmed against a real overflow — no such
incident is in the repo. Invocation/bandwidth overage on Hobby generally throttles or 500s
the deployment; unguarded here either way.

## 3. Spotify Web API

**(a)** `[general, verify]` — Spotify publishes no exact numeric limit (commonly described
as a rolling ~30s app-level window, unverified). This repo's own comments treat it as
opaque and reactive, not a known number: "We can't tell them apart from the response"
(403 vs transient), and Spotify sometimes hands out "multi-hour bans"
(`src/lib/spotify/client.ts:18-20,133-142`).

**(b)** Entirely client-side, self-logged: every outgoing call is recorded fire-and-forget
into `api_log` (`db.ts:2180-2208`, 1 h TTL, `db.ts:2177`), summarized into rolling windows
(`getApiLogSummary`, `db.ts:2218-2239`) used only reactively — printed on the *first* 429
of a call (`client.ts:118-127`). **No server-side Spotify accounting exists to check
against** — Spotify has no usage/quota endpoint like Turso's platform API, so `api_log` is
the only signal there is, by construction not choice.

**(c)** No proactive alarm. Purely reactive: a 429 sets a module-scoped `cooldownUntil`
other requests respect (`client.ts:41-46,118-142`); a long ban (`Retry-After` > 120s)
persists to the DB so other instances back off, capped 30 min (`client.ts:24-27,139-142`).
Nothing e-mails/pages on throttle or ban — the sync route swallows a 429 into
`200 {skipped:"rate-limited"}` so cron-job.org never sees it as a failure
(`src/app/api/cron/sync/route.ts:69-74`).

**(d)** Already happened: a multi-hour ban (~3.6h Retry-After) hit 2026-08-08 ~5:26–9:04 AM,
during which primary sync was fully down and only the independent Zenbook backstop recorder
kept history from being lost (`docs/READ_QUOTA.md:200-214`). The app degrades silently — home
page and cron both keep returning `ok: true` through a ban — with no signal beyond one
`console.warn` nobody watches in production.

## 4. cron-job.org

**(a)** `[general, verify]`, **unverified** — free-tier execution-count/day and job-count
limits exist but no figure is stated anywhere in this repo. Two of its jobs are in play:
the 2-min sync pinger and the daily usage-check job (`README.md:37-40`, `READ_QUOTA.md:144`),
alongside Vercel's own daily cron backstop (`vercel.json:1-6`).

**(b)** Only indirectly, and only for *job-disabled* state: `ensureCronJobEnabled()`
(`src/lib/cronjob.ts:3-9`) polls whether the sync job is `enabled` and re-enables it if
auto-disabled after failures, called from the daily Vercel-cron watchdog
(`src/app/api/cron/sync/route.ts:39-48`). Nothing queries cron-job.org's own
execution-quota usage — no equivalent of Turso's platform-API check exists here.

**(c)** Partial — cron-job.org's failure e-mail on a *job* failing is relied on
(`docs/ARCHITECTURE.md:186-188`); nothing watches an account-level execution quota if one
exists on the free tier.

**(d)** If cron-job.org throttles/drops executions via an account-level limit (vs. job
failures), the app can't notice: the 2-min pinger is the sole app-closed coverage path
(`ARCHITECTURE.md:133-136`), and `recently-played` returns only the **last 50 plays** with
no paging back (`docs/GOTCHAS.md:141-146`) — a silent gap beyond ~3h of listening is
permanent play loss on the primary, mitigated only by the separate 15-min Zenbook backstop
recorder (`ARCHITECTURE.md:178-185`), itself unaudited here.

## 5. Auth.js / NextAuth session

Not metered — skipped per scope. (Token refresh rides the Spotify rate limit above via
`POST https://accounts.spotify.com/api/token`, `ARCHITECTURE.md:39`.)

## 6. Other — Zenbook recorder shares the Spotify app

`~/lazyboy-recorder/` polls `/me/player/recently-played` every 15 min on its own token
chain, adopted from "the dev token chain" 2026-08-06 (`ARCHITECTURE.md:178-185`).
`[general, verify]`: Spotify rate limiting is commonly understood to key off the developer
app (`SPOTIFY_CLIENT_ID`), and `README.md:33-38` / `src/lib/auth.ts:98,260` show one shared
app across dev/prod — so the recorder's calls plausibly count against the same bucket as
the main app. Entirely invisible to `api_log`, which only logs calls through this repo's
`HttpClient` (`client.ts`); the recorder is a separate, unaudited process. A second,
independent instance of the same defect class.

---

## Summary — most alarm-worthy gaps

1. Turso is the only dependency with a real server-side counter **and** a working alarm.
2. Spotify has no server-side usage endpoint at all — `api_log` is self-logged, not ground
   truth, and can't see the Zenbook recorder's calls against the shared app. A multi-hour
   ban already hit production silently (2026-08-08).
3. Vercel has zero instrumentation — the one limit the repo names (4.5 MB function
   response) isn't the Data Cache per-entry limit actually relevant to the ~1.6 MB library
   payload, which is unverified and untested.
4. cron-job.org's account-level quota (if any) is unchecked — only per-job disablement is
   watched; a silent throttle would kill the 2-min pinger with no alarm, and Spotify's
   50-play window makes that loss permanent.
5. The pattern repeats three times (Turso pre-guard, Spotify, Vercel): a client-side model
   or log stands in for a server-side counter never queried or nonexistent. Every real
   incident (77% syncs burn, 86/91/102.8% rows-read burns, the Aug 8 ban) was caught by
   luck or a dashboard visit before Turso's usage-check existed as the one real guard.
