# Security review of the multi-user plan

Lane 0224_lb_mu_review_security, Oct 14-15, 2026. An adversarial review of `PLAN.md` in a fresh context,
one lens only: any path by which one user could read or change another's data, weak token handling,
and what the isolation design misses. Planning only: no code, data, store, Turso or Vercel setting was
changed. Code line numbers are against `ac6f7fe`, as the plan's are (`git diff --stat ac6f7fe HEAD --
src scripts ops tests vercel.json next.config.ts package.json` is still empty). §5 lists what I ran.

Status: in progress (outline).

## 0. Summary

(to be filled)

## 1. Findings, most severe first

(to be filled)

## 2. What holds up

(to be filled)

## 3. STORE_MIGRATION, from this lens

(to be filled)

## 4. Tests and checks to add

(to be filled)

## 5. What I ran

(to be filled)
