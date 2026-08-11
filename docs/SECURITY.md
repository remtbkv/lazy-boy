# SECURITY.md

Security posture and the checklist to clear before a public production deploy.
(Storage is currently a local SQLite file; if you move to Supabase/Postgres,
the user-scoping item below is handled by row-level security instead.)

## Already in place

- **Tokens never reach the browser.** The Spotify access/refresh tokens live in the DB
  (source of truth; the Auth.js JWT cookie is kept lean) and are only read server-side
  (Server Components, actions, route handlers). `src/lib/session.ts` is `server-only`.
- **Every API route checks `auth()`** and returns 401 (verified against production
  2026-08-11: `/api/sync`, `/api/metrics`, `/api/playlists/*`, `/api/search/*` all 401 without
  a session; `/api/now-playing` answers `{playing:null}`; `/api/build` is deliberately public
  and carries no personal data).
- **Every page that reads personal data gates for ITSELF**, before its first read. The `(app)`
  layout's `redirect()` is chrome, not the gate: Next renders a layout and its page in
  parallel, so a page under a redirecting layout still runs its fetches and still flushes its
  flight payload into the body of the 307. Measured 2026-08-11 — an unauthenticated
  `curl https://lazy-spotify.vercel.app/playlists` returned 70KB carrying every playlist name
  and cover URL next to `location: /login`; `/home` carried track names, artists and per-day
  play counts; `/usage` carried the ledger. The gate must not sit in a `Promise.all` with the
  reads either, or they run anyway.
- **Centralized token refresh** in `src/lib/auth.ts` (no scattered token handling).
- **No SQL injection.** All libSQL (`@libsql/client`) queries use bound params (`:name`/`?`).
- **Cron auth (fail-closed).** `/api/cron/sync` is session-less; it requires
  `Authorization: Bearer $CRON_SECRET`. An unset `CRON_SECRET` rejects every caller (it does
  not wave them through), so the endpoint can't be triggered anonymously in a misconfigured deploy.
- **CSRF.** Auth.js protects its routes; Next.js server actions are POST-only with origin checks.
- **Baseline security headers** in `next.config.ts` (`X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS).
- **Secrets are gitignored** (`.env.local`); only `.env.example` is committed.

## Before production — checklist

- [ ] **`AUTH_URL`** set to the real HTTPS origin; **`AUTH_SECRET`** is a strong random value
      (`openssl rand -base64 32`), stored in the host's secret manager, not in the repo.
- [ ] **User-scope the listen-history store.** `tracks`/`plays` are currently global (single
      user). For multiple users, add a `user_id` column keyed to the Spotify user and filter
      every query by it — or move to Postgres/Supabase with row-level security.
- [ ] **Spotify app out of development mode.** Dev mode blocks other users' data (403) and
      caps to 25 allowlisted users; request extended quota for real multi-user use.
- [ ] **Content-Security-Policy.** Add a strict CSP with per-request nonces for Next's inline
      runtime (omitted now because a naive CSP breaks the app).
- [ ] **Rate limiting** on route handlers / server actions (e.g. per-IP or per-user) to protect
      both this app and the Spotify quota.
- [ ] **Input validation** on route params (`q`, `day`, track `uri`/`id`) — currently
      lightly coerced; tighten before exposing publicly.
- [ ] **HTTPS enforced** end-to-end (HSTS is set, but confirm the host redirects HTTP→HTTPS).
- [ ] **No token/secret logging.** Keep the temporary `console.log` debugging out of committed
      code (none currently); scrub any error reporting of tokens.
- [ ] `allowedDevOrigins` is dev-only and harmless in prod, but review it isn't masking a real
      CORS need.

---

**Related:** [ARCHITECTURE → Auth & tokens](ARCHITECTURE.md#auth--tokens) (how refresh is
coordinated) · [GOTCHAS → Per-instance server state / Production security](GOTCHAS.md) ·
[ROADMAP](ROADMAP.md) (multi-user is Phase 3+).
