# 01c — Background work: history sync, library rescan, now-playing, the recorder, the scripts

Lane 0221_lb_mu_ov_sync, 2026-10-14. Planning only: nothing here changed code, data, the Zenbook
or Vercel. Line numbers are against commit `ac6f7fe`. Every number says how it was measured;
the exact commands are in Appendix A. "Rem's day" below means UTC 2026-10-14 unless stated.

Status: outline — sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Inventory: every background job today

## 2. Per run: Spotify calls, store reads and writes (measured)

### 2.1 The cron tick, by kind
### 2.2 What one landed play costs the store
### 2.3 The library rescan
### 2.4 The open-app paths: /api/sync and refreshHistoryAction
### 2.5 Now-playing
### 2.6 The backstop recorder
### 2.7 One user's day, totalled
### 2.8 Measurement caveats

## 3. Single-user assumptions on the background paths

## 4. Spotify's limits, which bound N

## 5. Running it for N users

### 5.1 The budget, per user and in total
### 5.2 Scheduling: a per-user due queue
### 5.3 Freshness from the player, completeness from batched harvests
### 5.4 Failure isolation
### 5.5 The open-app paths
### 5.6 The library rescan
### 5.7 The recorder and the loss floor
### 5.8 Vercel: invocations and wall time
### 5.9 Store reads and writes per user

## 6. STORE_MIGRATION: what multi-user needs, and what should change before it runs

## 7. Decisions that are Rem's

## 8. Unknowns

## Appendix A: exactly what I ran
