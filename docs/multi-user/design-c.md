# Design C — simplest safe migration first: a database per user

Lane 0222_lb_mu_design_c of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store or Vercel. Line numbers are against `774bb21` (`src/`,
`scripts/`, `ops/` and `tests/` are unchanged since `ac6f7fe`, the commit the six overviews cite;
`git diff --stat ac6f7fe HEAD -- src scripts ops tests` is empty). Every number is **[measured]**
with its source, or **[estimate]** with the arithmetic. Inputs: the six overviews `01a`-`01f` in
this directory, `docs/STORE_MIGRATION.md`, `docs/GOTCHAS.md`, `docs/SECURITY.md` and the code.
I did not read the other two designs.

Status: outline (sections fill in order; §0 is written last).

## 0. Summary

## 1. Targets, as briefed and as refined

## 2. The design on one page: what changes and what does not

## 3. Data model: where every table and meta key lives

## 4. Identity, sessions and per-user tokens encrypted at rest

## 5. Isolation: the enforcement points and the tests that prove them

## 6. Background sync for N users inside Spotify's limits

## 7. Search: per-user payloads, caching, and the phone budget

## 8. The store: Turso, a database per user, and STORE_MIGRATION

## 9. Migrating Rem's data with nothing lost

## 10. Sign-up gating, privacy, and account deletion

## 11. Rollout in reversible phases

## 12. Each target, step by step, with its budget

## 13. Costs

## 14. Targets no design meets, and the options

## 15. Decisions that are Rem's

## 16. Unknowns, risks, and what I ran
