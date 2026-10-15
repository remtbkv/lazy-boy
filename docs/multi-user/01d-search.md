# 01d — Search and the client: the two payloads, Home's first paint, and how they grow

Lane 0221 of the multi-user planning program, written 2026-10-14. Planning only: nothing here
changed code, data, the Zenbook store or Vercel. Line numbers are against commit `ac6f7fe`.
Every number is labelled **[measured]** (how, where, when) or **[estimate]** (the arithmetic).
The commands behind the measurements are in the appendix.

Status: outline — sections fill in order; each is committed as it lands. A section that still
reads "pending" was not reached.

## 0. Summary

_(pending)_

## 1. How search works today

### 1.1 The library payload: query, shape, cache layers
### 1.2 The history payload: query, shape, the slow marker
### 1.3 The two cache layers: the server data cache and the browser's ETag/304
### 1.4 Home's first paint and the idle loads, in order
### 1.5 Client-side matching: the search box, `fuzzyFilter`, `hanFold`, the day list

## 2. Measured on the owner's data

### 2.1 Payload sizes (raw, gzip, brotli)
### 2.2 Build time
### 2.3 Client cost: download, parse, index, filter per keystroke (desktop measured, phone estimated)

## 3. How each grows with a user's library and history

### 3.1 Bytes per library identity, per played song, per play
### 3.2 The ceilings: Vercel's 4.5 MB response cap, build time, phone memory and parse
### 3.3 Projections for a light, a typical and a heavy user

## 4. What multi-user changes for search

### 4.1 Keys: every cache key, ETag and version marker that has no user in it
### 4.2 Server cache footprint and rebuild load with N users
### 4.3 Security of the payloads (cross-user leakage paths)

## 5. What keeps it fast per user: caching and incremental updates

### 5.1 The options, each with its mechanism and cost
### 5.2 Recommendation and order of work

## 6. What multi-user needs from STORE_MIGRATION.md

## 7. Decisions that are Rem's

## 8. Unknowns and what I did not measure

## Appendix: commands run
