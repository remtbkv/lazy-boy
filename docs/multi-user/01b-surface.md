# 01b — The request surface: entry points, gates, caches, and where users would mix

Lane 0221_lb_mu_ov_surface, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. Line numbers are against commit `1c7aabb` (no file under `src/` changed between it
and `90e912f`, checked with `git diff --stat 1c7aabb HEAD -- src`). Every claim cites `file:line`
or a doc section; every number says how it was measured. Section 9 lists every command I ran.

Status: outline. Sections fill in order and are committed as each lands.

## 0. Summary

## 1. How a request learns who the user is today

### 1.1 The session cookie carries no Spotify id
### 1.2 Every Spotify call uses the one global token row
### 1.3 Every store read is unscoped
### 1.4 What that means right now: any valid session is the owner

## 2. Entry-point inventory

### 2.1 Pages
### 2.2 Server actions
### 2.3 API routes
### 2.4 Gate consistency

## 3. Caches and shared state, and whether each key separates users

### 3.1 Next's Data Cache (`unstable_cache`)
### 3.2 Version markers and ETags
### 3.3 Request-scoped boxes
### 3.4 Module and `globalThis` state (the task registry included)
### 3.5 Locks in `meta`
### 3.6 Browser-side state
### 3.7 Vercel-side surfaces: preview deployments, CDN

## 4. Entry points that would leak or mix data across users, as written

## 5. What the surface needs for multi-user

## 6. Exposures that exist today, single-user

## 7. What multi-user needs from STORE_MIGRATION.md

## 8. Unknowns and what I did not verify

## 9. What I ran
