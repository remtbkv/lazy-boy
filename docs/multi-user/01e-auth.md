# 01e — Authentication and secrets: how it works today, and what multi-user must change

Lane 0221_lb_mu_ov_auth, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. Line numbers are against commit `ac6f7fe`. Every number says how it was measured or
that it is an estimate.

Status: outline — sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Sign-in today, end to end

### 1.1 The provider: scopes, consent, redirect pinning, PKCE and state
### 1.2 The signIn callback and the owner guard
### 1.3 The jwt callback at sign-in: where the tokens go
### 1.4 The session cookie: what it is, what it holds, how long it lives
### 1.5 The session callback: what reaches the browser
### 1.6 Sign-out

## 2. Token storage and refresh

### 2.1 The `meta.spotify_tokens` row
### 2.2 Request-path refresh: jwt callback → `refreshShared` → `coordinatedRefresh`
### 2.3 The cross-instance lock and its lease arithmetic
### 2.4 Session-less refresh: `getValidAccessToken` (cron, background tasks)
### 2.5 Terminal versus transient failure, and `clearTokensIfStale`
### 2.6 The legacy cookie-token migration path

## 3. Secrets: who holds what

### 3.1 Inventory
### 3.2 Blast radius and rotation per secret

## 4. Census: every single-user assumption in auth

## 5. What multi-user must change

### 5.1 Identity: the session must name the user
### 5.2 Per-user token rows, locks and request boxes
### 5.3 Encryption at rest and key handling on Vercel
### 5.4 Sign-up gating in place of the owner guard
### 5.5 Account linking
### 5.6 Session fixation, sign-out and server-side revocation
### 5.7 When a user revokes the app
### 5.8 Account deletion
### 5.9 Session-less paths acting for N users

## 6. What multi-user needs from STORE_MIGRATION.md

## 7. Decisions that are Rem's

## 8. Unknowns and what I did not verify
