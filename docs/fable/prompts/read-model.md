# Fable mission — Lazy Boy's read model

Run under the operating pattern in
`~/projects/diveloop/research-coord/FABLE_PROMPT_TEMPLATE.md` (Role / Latitude /
Act-don't-ask / Parallelize / Token-efficiency / Close-the-loop). Three adaptations, since
this is Lazy Boy and not DiveLoop: substitute this repo's own knowledge files
(`docs/GOTCHAS.md`, `docs/ARCHITECTURE.md`) for the DiveLoop coordination artifacts; use
`~/lazyboy-review/` for `~/diveloop-review/`; and the preamble's pinned constraints about
capped/spot-first paid runs and other chats' experiment lanes are **moot here** — this
mission spends nothing and shares the repo with nobody. The one pinned constraint that does
carry over: nothing committed or deployed without Rem. **Latitude still outranks everything
below.**

Repo: `~/projects/lazyboy`, branch `main`. Prep: `docs/fable/prep/read-model-facts.md`.

---

## Usage posture

Scarce. There is **no paid compute anywhere in this mission** — no boxes, no runs, nothing
billable, so nothing is on a wall-clock critical path and there is no launch to start early.
The only expensive resource is your own credits. The critical path is your full-depth read of
`src/lib/db.ts` (1381 lines) and the inference pass on the measurements; route the
benchmarking, inventories and doc edits down to agents and spend your tokens on the reserved
functions in §6 of the guidelines.

## Mission — the invariant

When you are done, both of these hold on `main`:

1. **Every user-visible read path in Lazy Boy is fast enough to read as instant to a person
   using the app, under the conditions the app actually runs in** — and that is shown by
   repeated measurement, each figure stated beside the no-op baseline (`SELECT 1`) and the
   spread for that same run.

2. **No value derived from the store can silently disagree with what it is derived from.**
   Either the derived value does not exist, or something exists that *fails* when it goes
   stale and has been observed failing on purpose.

**Demonstrated by:** repeated-measure numbers for the read paths named in the prep, taken in
both a cold process and a warm one; plus, for whatever survives your review as a derived
value, one deliberate staleness injection that the guarding mechanism catches.

**Evidence of where the invariant currently breaks — NOT the scope boundary.** Rem's report,
verbatim in substance: history search "should be like super instant, like on the spot" and is
not; opening the page is "really slow loading into it," a problem he believes was fixed before
and has returned. Two changes were shipped against those symptoms this morning (`76e2c61`,
`37af0ea`, both summarised in the prep) — **they are context, not a foundation.** Rem's own
framing when he asked for this review: *"I don't think that upgrading to a faster plan would
fix this. I mean, there's just stuff we can do with their logic."* Treat the existing design,
including this morning's, as a hypothesis you are free to discard entirely.

**Required final pass.** Adversarially ask how the invariant could still break after whatever
you do, and sweep for sibling instances of every defect class you touch.

## Defect classes to chase, not just instances

Per guidelines §2 — for each: name the class, find its siblings, and say what **mechanism**
(a gate, a test, an assert, a lint) makes the class impossible, not what convention would
avoid it.

**Class A — a value derived from source data whose freshness depends on someone remembering
to call a recompute.** Six live instances with six different invalidation stories are
inventoried in prep §3; three of them (`alltime_stats`, `unique_song_count`, `plays.ctx_orphan`)
are hand-maintained lists of call sites, and no test recomputes any of them from source and
asserts equality. The equality checks that were run were one-off scripts, run by hand, since
deleted.

**Class B — a performance claim taken from a single measurement against a backend that varies
3–10×, then encoded as a rule that shapes later design.** This one has already done damage and
is the more interesting of the two. The query-conventions block at `src/lib/db.ts` lines 21–38
— drive joins from the indexed hot table, `LEFT` not `INNER`, never SQL window functions, cache
aggregates in `meta` — is derived from figures like `"INNER was 150ms–1.5s+ here, LEFT is a
steady ~50ms"` and `"~3s for ~1.5k rows"`, none of which has been re-measured with repetition
(prep §6). The same authoring session then repeated the mistake: numbers in commit messages
`76e2c61` and `37af0ea` read 3–7× larger than the medians that replaced them hours later.
**Every convention in that block is therefore suspect, and so is any design decision that
followed from it.** Re-measuring them is cheap and delegable; deciding what survives is not.

## Ownership, serial edges, out of scope

- Nothing else is running against this repo. You own the working tree.
- **`src/lib/db.ts` is the serial edge** — one owner at a time. Every read path, both syncs
  and the token store go through it. Agents editing it concurrently will collide.
- **The live production DB is shared with the deployed site.** Prod currently runs `76e2c61`
  (replica, no stored source verdict) while local `main` is at `37af0ea`; the DB already
  carries a backfilled `ctx_orphan` that the deployed code ignores harmlessly. Writes you make
  hit Rem's real listening history.
- `plays` is irreplaceable (prep §7). No destructive migration on it without a dump first.
- **Nothing is committed or deployed without Rem.** Note: a push and auto-deploy happened
  within minutes of a local commit this morning without the committing session initiating it,
  so treat "committed" as potentially "live" and don't rely on local-only as a safety margin.
- Out of scope: Spotify feature work, UI/visual redesign, auth flow, the friends features
  (blocked by Spotify dev-mode 403).

## Deliverables, each with its own bar

Guidelines §3: one end-to-end observation under real conditions per mechanism; synthetic tests
necessary, never sufficient. Guidelines §6 floor, translated for this mission: **every timing
bar states what a no-op scores** — the `SELECT 1` median *and* spread from the same run — because
a claimed 40 ms win against a backend whose floor measured 37–440 ms is not a measurement.

1. **A verdict on the read model's shape.** Whatever you conclude — keep, amend, or replace —
   grounded in your own full-depth read of `src/lib/db.ts`, not the prep's summary of it.
   *Bar:* names what the store's read model should be and why, with the alternatives you
   rejected and the evidence that rejected them; explicitly answers whether raw-plays-plus-N-
   caches is the right shape or an accumulation of patches.

2. **Re-measured conventions.** The rules in `db.ts` 21–38, re-derived from repeated
   measurement.
   *Bar:* every surviving rule cites a median + spread + n and the baseline for that run; every
   rule that does not survive is deleted from the file, not left standing with a caveat.

3. **Whatever the verdict implies, implemented.** Could be nothing.
   *Bar:* for any change to a read path, an oracle diff against the current implementation over
   **all** rows, not a sample, showing what changed and what didn't; `tsc` + `lint` + `build`
   pass; repeated-measure before/after with baselines.

4. **A staleness mechanism for whatever derived values remain.**
   *Bar:* observed catching a deliberately corrupted value. Break one on purpose and show the
   mechanism firing. A green test on untouched data proves nothing.

5. **A production-side answer.** No authed end-to-end render has ever been measured on Vercel
   (prep §5) — every number in this repo is from a local process against the remote DB.
   *Bar:* either a real measurement of an authed `/home` render and a search in production, or
   an explicit statement of what blocked it and what would unblock it. Do not infer it.

6. **Corrected commit messages, or a note.** `76e2c61` and `37af0ea` still carry the inflated
   single-shot figures (prep §6). Either amend them or record the correction where a reader of
   the history will find it. Class B is not closed while its own evidence is still wrong.

## Author leans — non-binding

Everything below is what the authoring session *believes*, not what it knows. It appears
nowhere in the mission, deliverables or bars on purpose.

**The plan is yours. Adopt, modify, or discard any lean; pursue what the evidence supports even
if no lean names it. Latitude outranks this prompt's framing.** Engage each in your report:
adopted / modified / discarded, one line why.

1. **The embedded replica is the right call.** Evidence: prep §4 — 100–1000× on every scanning
   read, and reads fall back to the primary until it syncs, so cold is never worse. *Medium.*
   Wrong if real traffic is cold-start dominated, or if a remodel makes the scans small enough
   that a local copy buys nothing.
2. **`ctx_orphan` is correct but may not have been worth it.** 0 mismatches over 6,644 plays is
   solid; but repeated measurement then showed the win is ~7× on the replica and 1.3× on the
   primary and *nil* for one day's plays. It bought a real speedup on a path that was already
   sub-10 ms and added an invalidation surface. *High confidence in the correctness, low that
   the trade was right.* Wrong if the replica turns out not to be dependable in production, in
   which case the primary-side win is what matters.
3. **The read model may be wrong at the root.** The store keeps raw plays and derives everything
   at read time, then patches each derivation with a cache once it gets slow — `alltime_stats`,
   then `unique_song_count`, now `ctx_orphan`, plus the replica. Four caches, four invalidation
   surfaces, no test over any of them. A single materialised read model might subsume all of
   them. *Low-medium — this is a smell, not an analysis.* Wrong if the derivations are genuinely
   independent and a unified model would couple things that should stay apart.
4. **The query-conventions block may be built on noise.** See Class B. *Medium.* Wrong if
   re-measurement reproduces the original figures, which would make the conventions sound and
   the variance a recent condition.
5. **An FTS index for history search is not worth it.** `LIKE '%q%'` scans `tracks`, but it is
   ~6 ms on the replica and `tracks` grows with distinct songs rather than plays. *Medium-low —
   measured only on the replica; the primary-side case was never examined.* Wrong if the
   replica is unreliable in production, or if `tracks` grows faster than assumed.
6. **The day-strip mount prefetch is the next growth problem.** `dailyStatsAction(100000)` reads
   every play on every Home mount — 13 ms warm today, linear in total plays forever. *Medium.*
   Wrong if it should simply be deleted rather than optimised.
7. **The authoring session's blind spot, stated plainly so you can correct for it:** it reached
   for infrastructure (add a replica) when Rem was pointing at the data model, and it anchored
   on its first measurements instead of repeating them. Both this prompt and the prep were
   written by that session. Distrust the framing accordingly.

## Delegation

Guidelines §5. **Opus** for anything touching `src/lib/db.ts`, the live DB, or a migration —
this is live personal data with an irreplaceable table in it. **Sonnet** for benchmark
harnesses, inventories, doc rewrites, and mechanical edits from a tight spec. Every agent gets
disjoint file ownership, an explicit return contract, and its own bar.

**Reserved to you** (guidelines §6): the full-depth read of `db.ts` and the two commits — not
an agent's digest of them; the logic pass on every equivalence verdict before it is believed;
authoring the measurement protocol *before* any number is taken (n, warm/cold, baseline,
what counts as a difference); and the contradiction hunt across whatever your agents return.

**The §6 adjudication floor applies:** any equivalence claim ("identical rows", "0 mismatches")
gets a delegated companion pass that re-checks the claim against the artifact it cites. The
one-off scripts behind the existing claims are deleted and cannot be re-read (prep §5) — so
those claims are unverifiable as they stand and either get re-derived or get labelled.

## Found work

Guidelines §10. Adjacent breakage you hit — a wrong number in a doc, a stale claim, a missing
guard, a dead code path — gets fixed at the same bar or queued explicitly. Two already known:
`docs/` still describes a `subtract-panel` and a `syncHistoryAction` that no longer exist in
`src/`. The missions are the spine, not the fence.

## Closing

- Structured report + judgment-call log to `~/lazyboy-review/` (create it; Rem reads and
  deletes from there).
- Fold anything durable into `docs/GOTCHAS.md` / `docs/ARCHITECTURE.md` — that is where this
  repo keeps its lore, and both were updated this morning, so read before you write.
- A spoken summary at the end: what the read model should be, what changed, what is still
  unverified.
- Commit author is **Rem Turatbekov `<remtbkv@gmail.com>`**, never Claude, and no AI
  co-author or generated-by footer.
