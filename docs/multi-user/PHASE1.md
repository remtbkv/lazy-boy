# Multi-user Phase 1, built ahead of its turn

Lane 0226_lb_mu_phase1, Oct 15, 2026, branch `mu/phase1` (worktree
`~/projects/lazyboy-wt/mu-phase1`), cut from `main` at `6577f4b`. Nothing here is merged, pushed or
deployed, and nothing touched production data, the Zenbook store or Vercel.

Status: in progress. Sections are filled in as each piece lands; a section still reading "pending"
was not reached.

## 1. What this branch is

PLAN.md §13.1 puts Phase 1 after P3; §13.4 lets a lane build a phase early on its own branch, but
only in new files and in files no queued lane edits. §18's last table names the Phase 1 work no
decision of Rem's holds. This branch builds the intersection of the two.

The files queued lanes edit, and which this branch therefore leaves alone (§13.4, STORE_MIGRATION
§6 and §10): `src/lib/db.ts`, `src/lib/store-fetch.ts`, the cron routes that exist today
(`/api/cron/sync`, `/api/cron/usage-check`), `/api/metrics`, the two search routes,
`usage/page.tsx`, `instrumentation.ts`, `vercel.json`, the `(app)` layout, Home's load path
(`home/*`, `history-actions.ts`), the import scripts and the Zenbook meter. One exception, flagged:
`src/app/(app)/actions.ts`, where the Phase 0 lane gates `logout`; this branch changes two other
hunks there (the task owner on the two `runTask` calls), which rebase cleanly against a change at
lines 63-69.

That boundary decides most of what is left for the phase's turn (§4): the mechanical `forUser`
edit through `db.ts`, the seven cached reads moving onto `userCache`, the uid in the search ETags
and bodies, and the reads and gates inside Home and the search routes.

## 2. What is built

pending

## 3. The tests, and what each proves

pending

## 4. Left for Rem's decisions, or for the phase's turn

pending

## 5. How to review the branch

pending
