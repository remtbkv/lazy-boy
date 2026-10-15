# Multi-user 03: performance, store scaling, search and uptime

Lane 2203, 2026-10-14. Planning only: nothing here changed code, data, the Zenbook or Vercel. Every
number is labelled **[measured]** (with how and when) or **[estimated]** (with the arithmetic). Citations
are `file:line` at commit `1c7aabb` or a doc section.

## Contents

0. Summary
1. Today's numbers (one user)
   1.1 Search payloads
   1.2 Home's first paint path
   1.3 History sync
   1.4 Library sync
   1.5 The store: tables, growth, slow queries, indexes, reads
   1.6 Uptime
2. Scaling to N = 5, 25, 250
   2.1 Inputs and assumptions
   2.2 Store size and growth
   2.3 Store reads and writes per day
   2.4 Sync work and Spotify calls per minute
   2.5 Search payload build cost and caching per user
   2.6 Vercel function time
   2.7 The Zenbook's CPU and disk (if it stays the store)
3. What keeps search fast per user
4. What keeps uptime
5. What multi-user needs from STORE_MIGRATION.md
6. Open questions and unknowns

(Sections are filled in order; a section reading "TODO" was not reached.)

## 0. Summary

TODO

## 1. Today's numbers (one user)

TODO

## 2. Scaling to N = 5, 25, 250

TODO

## 3. What keeps search fast per user

TODO

## 4. What keeps uptime

TODO

## 5. What multi-user needs from STORE_MIGRATION.md

TODO

## 6. Open questions and unknowns

TODO
