# Review of PLAN.md: uptime, the store, and moving Rem's data

Lane 0224_lb_mu_review_migration, Oct 14, 2026. An adversarial read of `docs/multi-user/PLAN.md`
(as committed at `0ca7ab5`) through one lens: single points of failure, behaviour when the Zenbook or
the new store is down, and whether moving Rem's existing data could lose or mis-assign anything.
Isolation, auth and search have their own reviewers; this file stays out of them except where they
meet the store. Planning only: nothing here changed code, data, the Zenbook, Turso or Vercel.

Severity: **S1** loses or mis-assigns Rem's data, or takes every user down, with no plan step that
catches it; **S2** a plan claim that is wrong or unproven in a way that changes a decision or a
runbook step; **S3** a gap a lane would trip over; **S4** wording or a number to correct.

## 1. Findings, by severity

(in progress)

## 2. What holds up

(in progress)

## 3. What I ran

(in progress)
