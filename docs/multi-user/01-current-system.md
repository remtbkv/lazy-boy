# 01 — The current system, and every place it assumes one user

Lane 2201 of the multi-user planning program, written 2026-10-14. Planning only: nothing here
changed code, data, the Zenbook store or Vercel. Line numbers are against commit `1c7aabb`.

Status: outline — sections fill in order; each is committed as it lands.

## 1. The system as it runs today

### 1.1 The pieces and the wires (diagram in words)
### 1.2 Request paths: pages
### 1.3 Request paths: server actions
### 1.4 Request paths: API routes
### 1.5 Scheduled paths: cron, the Zenbook timer, the backstop recorder
### 1.6 The store: schema, tables, indexes
### 1.7 The store: `meta` keys
### 1.8 Caches: `unstable_cache`, ETags, browser caches, module-scope state
### 1.9 The usage ledger and client metrics
### 1.10 External pieces: Spotify, Vercel, the Zenbook

## 2. Census of single-user assumptions

Sizes: **S** = a key or a filter added in one place; **M** = a function's contract or a
table's key changes, with callers to follow; **L** = a design change (new mechanism,
a schema migration over live data, or a loop that must fan out per user).

### 2.1 Identity and auth
### 2.2 Tokens and refresh locks
### 2.3 Store schema (tables without a user)
### 2.4 `meta` keys
### 2.5 Derived payloads and caches
### 2.6 Search payloads and ETags
### 2.7 Sync: history, library, playlist tracks
### 2.8 Cron, the Zenbook timer, the recorder
### 2.9 Server actions and pages
### 2.10 Task registry and module-scope state
### 2.11 Usage ledger, metrics, `/usage`
### 2.12 Scripts, ops and file paths

## 3. What multi-user needs from STORE_MIGRATION

## 4. Unknowns and what I did not measure
