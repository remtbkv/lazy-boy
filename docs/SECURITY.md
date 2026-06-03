# SECURITY.md

Security posture and the checklist to clear before a public production deploy.
(Storage is currently a local SQLite file; if you move to Supabase/Postgres,
the user-scoping item below is handled by row-level security instead.)

## Already in place

- **Tokens never reach the browser.** The Spotify access/refresh tokens live in the
  encrypted Auth.js JWT and are only read server-side (Server Components, actions, route
  handlers). `src/lib/session.ts` is `server-only`.
- **One auth gate.** The `(app)` layout calls `auth()` and redirects unauthenticated users;
  every API route also checks `auth()` and returns 401.
- **Centralized token refresh** in `src/lib/auth.ts` (no scattered token handling).
- **No SQL injection.** All libSQL (`@libsql/client`) queries use bound params (`:name`/`?`).
- **Cron auth.** `/api/cron/sync` is session-less; it checks `Authorization: Bearer $CRON_SECRET`.
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
