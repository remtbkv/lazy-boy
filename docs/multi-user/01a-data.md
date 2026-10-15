# 01a — The data layer: store, schema, queries, volumes, and every single-user assumption

Lane 0221_lb_mu_ov_data of the multi-user planning program, Oct 14, 2026. Planning only: nothing here
changed code, data, the Zenbook store or Vercel. Line numbers are against commit `ac6f7fe` (`src/`,
`scripts/`, `ops/` and `tests/` are identical to `1c7aabb`). Every number is labelled **[measured]**
(with how and when) or **[estimated]** (with the arithmetic); every statement I ran against any store
is listed in §11.

Status: outline. Sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Where the data lives and how it is reached

## 2. Schema: every table, column and index

## 3. `meta`: every key

## 4. Query sites: every statement, its caller, its trigger and how often it runs

## 5. Derived data and caches built on the store

## 6. Volumes: row counts, sizes and growth per day (the owner's data)

## 7. Census: every single-user assumption in the data layer

## 8. What the data model needs for multi-user

## 9. How the data scales with N users

## 10. STORE_MIGRATION.md: what multi-user needs from it, and what should change before it runs

## 11. Measurement log and unknowns

## 12. Decisions that are Rem's
