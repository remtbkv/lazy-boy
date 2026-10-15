# Multi-user lazyboy: the plan

Lane 0223_lb_mu_synthesis of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. It synthesizes the six overviews
(`01a-data.md` to `01f-platform.md`, cited as 01a §n and so on) and the three designs (`design-a.md`,
`design-b.md`, `design-c.md`, cited as A §n, B §n, C §n). Code line numbers are against `ac6f7fe`,
which the overviews cite; `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json
next.config.ts package.json` is empty at `7e0c5b1`. Every number is **[measured]** with its source or
**[estimate]** with its arithmetic. §17 lists everything this lane ran.

Status: outline; sections are filled in order and committed one by one.

## 0. Summary

(to fill last)

## 1. Targets

(what the plan is built to meet, how each is measured, and what changed from the brief)

## 2. The three designs compared, and what this plan takes from each

(point-by-point comparison with the choice and its reason)

## 3. The plan on one page

(the architecture, the rules it holds itself to, the order of work)

## 4. Data model

(the app database, the user databases, every table and meta key, the user key, schema versions)

## 5. Identity, sessions and per-user tokens encrypted at rest

## 6. Isolation: enforcement in one place, and the tests that prove it

## 7. Sync fan-out inside Spotify's limits

## 8. Store cost: the write path and the read levers

## 9. Search: per-user payloads, caching and the phone budget

## 10. The store, and STORE_MIGRATION (lanes 1901-1911)

## 11. Migrating Rem's data with nothing lost

## 12. Sign-up gating, privacy, deletion and backups

## 13. Rollout in reversible phases

## 14. Each target, step by step, with its budget

## 15. Costs

## 16. Unknowns and risks

## 17. What I ran

## 18. Decisions that are Rem's
