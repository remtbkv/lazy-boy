# Rem's rulings on the multi-user plan

Each ruling names the PLAN.md section 18 decision it settles. Lanes building a phase read this beside PLAN.md; a
ruling here overrides the plan's recommendation where they differ.

## Oct 15, 2026, 12:26 PM

- **Decision 22, friends' history: kept indefinitely while they stay connected.** Rem: "friends' history is kept
  indefinitely. That's the whole point ... I don't think these songs take up much space." So no idle pause and no
  12-month deletion. What still applies, because Spotify's terms require it whatever the retention: a friend who
  disconnects has their data deleted within five days, backups included (Developer Terms, Data Protection Appendix
  §5; 01f-platform.md §1.5). The terms also say "Do not store Spotify Content indefinitely" (Section IV); 01f §1.5
  reads that as defensible for one person's own history and weaker for several people's. Rem has taken that risk.
- **Decision 25, the privacy policy: later.** Not needed while Rem is the only user. Spotify's terms require a privacy
  policy and an end-user agreement shown before anyone else signs up (Section V), so both are due before Phase 4a's
  canary account; tracked in .claude/QUEUE.md.

## Oct 15, 2026, 1:33 PM

- **Decision 19, revised again: logging out stops capture, and says so.** Rem: "when you log out, you stop capturing.
  That should be kind of like a thing. Like a note saying, after you logged out, it said, stopped logging listening
  history as well." So "Log out" signs the person out of every browser and stops recording their listening history,
  and the page after it says so plainly, with how to resume (sign in again). Plays during the gap come back only as far
  as Spotify's recently-played list reaches (its last 50) at the next sign-in.
- **Decision 9: go.** Dispatched as DiveLoop lane 2202_dl_dnsfb (6.5, outside practice windows), since the Zenbook
  also runs the camera rig.

## Oct 15, 2026, 1:17 PM

- **Decision 8, the second pinger: yes.** Rem sets up the cron-job.org job (every 2 minutes, GET
  /api/cron/sync with its own bearer secret); the route learns the second secret and the 90-second guard first.
- **Decision 9, a DNS resolver on the Zenbook that does not need Tailscale:** explained to Rem (a settings change, no
  cost); the Zenbook also runs DiveLoop's camera rig, so it is scheduled with DiveLoop's orchestrator.
- **Decision 17, Turso's paid plan: no.** "We're not going to go on any $5 month plan ... I'm sure we can make this
  super optimized. Even with five people, we're not going to go over the limit because it should all be bounded."
  Stay on the free plan by design: reads and writes bounded by what the app can do.
- **Decision 18, Vercel Pro: no.** "We just need to optimize our system, maybe offload some more of the CPU work to
  my Zenbook ... minimize the usage on there on Vercel and Turso ... while keeping maximum speed." So recurring and
  heavy work (the 2-minute capture tick's work, payload rebuilds, scans) runs on the Zenbook where it can; Vercel and
  Turso serve what must be fast for a person waiting.
- **Decision 19, revised: two options.** "Log out" signs this person out of every browser (capture continues);
  "Disconnect" (that name only) removes the account. Rem: "if you want to do all browsers at that point, just
  disconnect."
- **Decision 20, revised.** A session whose Spotify grant has died shows a short, helpful error saying what happened
  and what to do, then the sign-in page; never a silent redirect.
- **Decision 21: yes, and never Rem's.** A friend who revokes access has their data deleted on day 4 unless they
  reconnect. Rem's own data is never deleted by any automatic path.
- **Decision 28: two-minute updates for everyone.** The brake stays only as the safety valve the plan describes,
  engaging if the app's shared daily Spotify allowance runs low.

## Oct 15, 2026, 12:46 PM

- **Sign-up is a request form, and Rem adds people by hand.** Spotify's User Management allows five accounts, Rem
  included, so up to four friends. Rem: "a form somewhere in the site ... as you sign up for it, you would have to put
  in some name. The name doesn't really matter ... Name can be optional ... if there's no name submitted, then we just
  put some sort of filler thing in there ... the email, and then we add them in, and then it's all good." So a friend's
  first visit asks for an email (required: the one on their Spotify account, which is what User Management matches)
  and a name (optional; a filler when blank); Rem sees the requests and adds the email in Spotify's dashboard; after
  that the friend connects with Spotify as usual. At most four friends while the app is in development mode.
- **Decision 1 done.** AUTH_SECRET rotated at 12:46 PM with separate Production and Preview values, production
  redeployed at 12:47 PM; every older session cookie, the Oct 14 second account's included, is void. The deployments
  built before the rotation are deleted a day later (PLAN.md decision 1).

## Oct 15, 2026, 12:43 PM

- **Decision 25, revised: make the privacy policy now, short and plain.** Rem: "go and make the privacy policy.
  Have it be whatever ... just a different place to press accept." Lane 2011_lb_privacy builds /privacy and /terms
  (with Spotify's required end-user terms) and a consent line beside the login page's connect button. Short, but
  true to what the code does: it promises nothing the app does not have.
- **Done (Oct 15):** /privacy, /terms and the consent line on /login exist, from commit 130cb13 (lane 2011).

## Oct 15, 2026, 6:21 PM

Rem: "I approve of all the previous stuff you told me for the recommendations. Just keep things going." That
approves, as recommended to him on Oct 15:

- **Decisions 2-7, 11, 13-16, 23-24, 26-27 and 29-30, as PLAN.md section 18 recommends them,** with decision 16
  as a 48-hour canary (FASTPATH.md). Decisions 2-3's eight STORE_MIGRATION edits landed in d3ac1f7.
- **The fast path (FASTPATH.md section 4.1): the first friend connects Tuesday Oct 20 in the evening,** or Wednesday
  if tonight's cutover misses its slot.
- **Store lanes alongside STAT through Friday Oct 16.** Lanes 1901-1906 and 1910-1911 run without `--stat-first`;
  STAT lanes still start first (STORE_MIGRATION section 7).
- **A standing go-ahead for phase deploys** whose tests, build and adversarial review are green. Each deploy is
  reported to Rem when it lands.
- **Agents stay off friends' rows.** Spotify's Developer Policy: "Do not … ingest Spotify Content into a machine
  learning or AI model." Agent sessions debug on Rem's own rows, and /privacy says so. The roadmap's AI playlists
  wait for a closer reading of that clause before anyone builds them.
- **Backups keep only Rem's rows** (.claude/QUEUE.md, after store phase D), because /privacy promises a departed
  friend's data is gone within 5 days, backups included.

## Oct 15, 2026, 9:27 PM

- **Decision 16, revised: no canary account and no 48-hour canary.** Rem: "I don't really want to add a free
  account to test ... I think we can just be sure of it regardless just by like API logic and like our code logic
  itself. So ... take that 48 hours off this." In its place, two checks that need no account of his:
  - a two-user rehearsal on a production build, with two synthetic users through the scripted Spotify stand-in
    (tests/), covering FASTPATH.md section 2.4's list: `cache()` in route handlers, the Data Cache across
    environments, one instance serving two users, two token refreshes in one tick, the shared-device case, the
    probe's e-mail, and deletion reaching backups;
  - the first friend's first hour run as the exit checks, with `SIGNUPS=owner` ready as the one-redeploy freeze
    (PLAN section 13.6).
  Phase 3's 24-hour soak on Rem's own account stays. The first friend can connect Monday Oct 19 in the evening.
- **The UI overhaul waits.** "the UI stuff is like should be for later. It's not our important thing now." The
  design comparison lane is held (~/.claude/broke/scratch/lazyboy_design/held/).
- **What matters now, in his words:** "get all this migration properly done. as well as like any of the
  functionality and security on the backend, as well as performance with our database and make sure it's bounded
  for [V]ercel so we can have up to like five accounts, you know, at maximum ... realistic usage, make sure that
  still doesn't flip over and we have [a] way enough room to spare."
