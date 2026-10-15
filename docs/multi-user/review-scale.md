# Review of PLAN.md: performance and scale

Lane 0224_lb_mu_review_scale, Oct 14-15, 2026. An adversarial review of `docs/multi-user/PLAN.md`
through one lens: performance and scale. Every budget and every piece of arithmetic in the plan was
recomputed from the code and the six overviews' measurements, at 5, 25 and 250 users; where the
existing data could answer a question the plan calls unmeasured, I measured it on a local copy.
Planning only: nothing here changed code, data, the Zenbook store, Turso or Vercel. Security,
isolation and product scope belong to the other three reviewers and stay out of this file.

Line numbers are against `ac6f7fe` (`git diff --stat ac6f7fe HEAD -- src scripts ops tests
vercel.json next.config.ts package.json` is still empty). Plan sections are cited as "§n", the
overviews as "01a §n" and so on. Every number is **[measured]** with its source, or **[estimate]**
with its arithmetic. §4 lists everything I ran.

Status: complete, Oct 15, 2026.

## 0. Verdict

The plan's skeleton holds up under this lens: a database per user costs no extra reads, the
predicate rewrite is right on current data (§3), the December cache cliff is real and correctly
dated, and five users fit Turso and Vercel once the single-user levers ship. The arithmetic around
it is optimistic in four places, each of which a friend would find before Rem does:

1. **An open Home tab re-reads the day strip and today's rows after every write-marker move**, and
   P4 does not touch that path. §8.6 has no term for it; with "See all" open it grows with history
   (finding 1).
2. **Every friend-side number is Rem's library**, and Rem has 48 Liked Songs. A friend with
   thousands rewrites every `saved_tracks` row and re-pages the whole list on each like (finding 2).
3. **The scarce Spotify bucket is budgeted from plays, but the ceiling is probes**, and the brake
   is switched off for the one phase that first shares the bucket with an unknown listener
   (finding 3). Its ¾ step does nothing for equal users (finding 3c).
4. **Two numbers the plan calls unmeasured are in the logs already**: Spotify lists ~13% of plays
   only after the first harvest that follows them (F2's real tail is ~5 minutes at p95, not 2), and
   the app's busiest 30-second window without a 429 is 56 calls, not 18 (findings 4 and 6).

None of this changes the structure. Every fix below is small, and most belong in phases the plan
already has (P4, Phase 3, Phase 4's gates).

## 1. Findings, by severity

(to fill)

## 2. The arithmetic at 5, 25 and 250 users

(to fill)

## 3. What holds up

(to fill)

## 4. What I ran

(to fill)
