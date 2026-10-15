# 01f — The platform: Spotify's developer policy, Vercel, the Zenbook, Turso, and what each costs

Lane 0221_lb_mu_ov_platform of the multi-user planning program, written 2026-10-14. Planning only:
nothing here changed code, data, the Zenbook store or Vercel. Line numbers are against the commit
this file was first written on (`bca1713`); every vendor quote carries the URL it was fetched from
and the fetch time, and every number says how it was measured or that it is an estimate.

Status: outline — sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Spotify's developer policy today

### 1.1 What was fetched, and what could not be
### 1.2 Development mode: the allowlist and what it blocks
### 1.3 Extended quota mode: what it requires, and whether lazyboy can qualify
### 1.4 Rate limits: what Spotify publishes, what the app does, how one app's limit divides across users
### 1.5 Terms that bind a multi-user build (storage, retention, deletion, display)
### 1.6 What this means for multi-user

## 2. Vercel

### 2.1 Which plan the project is on, and how that was determined
### 2.2 The limits that matter on that plan
### 2.3 Today's usage against them, and the per-user growth
### 2.4 Where multi-user meets a Vercel limit first

## 3. The Zenbook: sqld behind a Tailscale Funnel, a single point of failure

### 3.1 What runs there
### 3.2 What fails today when it is down, path by path
### 3.3 How often it is down
### 3.4 The Funnel's own limits and the certificate
### 3.5 What multi-user changes about it

## 4. The planned Turso move

### 4.1 What STORE_MIGRATION does, and when
### 4.2 Turso's plans and prices today
### 4.3 Usage per user per month, from the meter
### 4.4 Where each plan runs out
### 4.5 What multi-user needs from STORE_MIGRATION, and what should change before it runs

## 5. Costs at 5, 25 and 250 users

### 5.1 The per-user assumptions
### 5.2 The options, priced
### 5.3 The table

## 6. Decisions that are Rem's

## 7. What I ran, and what I did not measure
