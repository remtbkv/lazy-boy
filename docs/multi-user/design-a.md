# Design A — isolation first: one user can never see or change another's data

Lane 0222_lb_mu_design_a of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. Line numbers are against commit
`774bb21`; `src/`, `scripts/`, `ops/` and `tests/` are identical to `ac6f7fe`, the commit the six
overviews cite (`git diff --stat ac6f7fe HEAD` over those paths is empty). Every claim about the
current system cites `file:line` or an overview section (01a-01f); every number is **[measured]**
with how, or **[estimate]** with the arithmetic. Section 17 lists everything I ran.

Status: outline; sections are filled in order and committed one at a time.

## 0. Targets, and the design on one page

(Targets table, refined from the brief; then the design in ten lines.)

## 1. Why isolation first, and the bugs it has to survive

## 2. Where enforcement lives

### 2.1 Layer 1: one database per user
### 2.2 Layer 2: a user id only the gate can mint
### 2.3 Layer 3: the store handle, and a database that names its owner
### 2.4 Layer 4: caches, process state and background tasks
### 2.5 Layer 5: Spotify credentials that carry their owner
### 2.6 Layer 6: the browser
### 2.7 The shared remainder: app database, telemetry, operator views, scripts
### 2.8 Every bug class against the layers
### 2.9 What isolation costs

## 3. Data model: how every table and meta key gets a user

## 4. Per-user tokens, encrypted at rest

## 5. Isolation tests

## 6. Sync fan-out within Spotify's limits

## 7. Search: per-user payloads and caching

## 8. The store, and what STORE_MIGRATION should change

## 9. Migrating Rem's data with nothing lost

## 10. Sign-up gating

## 11. Privacy

## 12. Account deletion

## 13. Meeting each target, step by step

## 14. Rollout in reversible phases

## 15. Costs

## 16. Decisions that are Rem's

## 17. What I ran, and what I do not know
