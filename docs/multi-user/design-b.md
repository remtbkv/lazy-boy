# Design B — multi-user lazyboy, performance and scale first

Lane 0222_lb_mu_design_b, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. One of three independent designs; this one starts from performance and scale: search
stays instant and sync stays fresh at 250 users on the cheapest store that holds, with the arithmetic
for every budget. Built on the six overviews (`01a-data.md` to `01f-platform.md`), cited as 01a §n
and so on; code line numbers are against `ac6f7fe` (no file under `src/`, `scripts/`, `ops/` or
`tests/` changed since). Every number is labelled **[measured]** with its source, or **[estimate]**
with the arithmetic.

Status: outline. Sections are filled and committed one at a time.

## 0. Summary

(to be written last)

## 1. Targets, as briefed and as refined

(the five targets, the refinements the overviews force, and how each is checked)

## 2. The design on one page

(the rule — per-user work proportional to what changed — the architecture, and what it replaces)

## 3. Where one user's cost goes today

(every per-user term with its measured cost and how it grows; which mechanism removes it)

## 4. Data model: how every table and meta key gets a user

(database per user plus an app database; every table and meta key mapped; the user key; schema
versioning in place of `init()`)

## 5. Tokens: per user, encrypted at rest

## 6. Isolation, and the tests that prove it

## 7. Sync: fan-out, freshness and Spotify's budget

## 8. The write path: derived data updated by append

## 9. Search: payloads, caching, and the budget for every step

## 10. The store budget per user per day, and the plan that holds at 5, 25 and 250

## 11. The store choice, and what STORE_MIGRATION needs

## 12. Uptime: the Zenbook and the other single points

## 13. Migrating Rem's data with nothing lost

## 14. Sign-up gating, privacy and account deletion

## 15. Rollout in reversible phases

## 16. Costs

## 17. Scorecard: each target met or missed, and the options where missed

## 18. Decisions that are Rem's

## 19. What I ran, and what I did not measure
