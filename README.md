# Spotify Claude Manager

A Next.js web app to manage your Spotify library: merge, clean, and compare playlists, save
your live queue, and mirror your liked songs — with room to grow into friends and AI
playlists. Clean rewrite of an earlier Flask/Django prototype.

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in the values (see comments in that file)
npm run dev                  # http://127.0.0.1:3000
```

### Spotify app setup

1. Create an app at https://developer.spotify.com/dashboard.
2. Add this Redirect URI: `http://127.0.0.1:3000/api/auth/callback/spotify`
3. Put the Client ID/Secret in `.env.local`.

Generate `AUTH_SECRET` with `openssl rand -base64 32`.

## Features

Merge playlists · Clean playlist (remove already-saved songs, with live progress) · Find
duplicates · Liked songs → mirror playlist · Save current queue · Listening history
(auto-synced) · Compare another user's playlists (savable song diff). See `docs/FEATURES.md`.

## Deploy your own

Single-user app — fork it and point it at your own Spotify app + database. Steps:

1. **Spotify app** — create one at the [dashboard](https://developer.spotify.com/dashboard).
   Note the Client ID/Secret. Add redirect URIs for every origin you'll use:
   `http://127.0.0.1:3000/api/auth/callback/spotify` (local) and
   `https://<your-domain>/api/auth/callback/spotify` (prod). It stays in Development mode
   unless you request extension — fine for personal use (friend features need allowlisting).

2. **Database (Turso/libSQL)** — install the CLI (`curl -sSfL https://get.tur.so/install.sh | bash`),
   then:
   ```bash
   turso auth login
   turso db create <name>                 # add --from-file ./data/listens.db to seed local data
   turso db show <name> --url             # → TURSO_DATABASE_URL
   turso db tokens create <name>          # → TURSO_AUTH_TOKEN
   ```
   Leave both unset locally to use a `data/listens.db` SQLite file instead.

3. **Env vars** — set these in `.env.local` (dev) and in your Vercel project (prod). See
   `.env.example` for the annotated list:
   | var | notes |
   |---|---|
   | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | from the Spotify dashboard |
   | `AUTH_URL` | `http://127.0.0.1:3000` locally; your exact prod origin on Vercel |
   | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | from step 2 (omit locally for the file fallback) |
   | `CRON_SECRET` | `openssl rand -base64 32`; shared with the sync cron |

4. **Deploy to Vercel** — import the repo, add the env vars above, deploy. Then set `AUTH_URL`
   to the exact assigned domain and add that domain's `/api/auth/callback/spotify` to the
   Spotify dashboard (redeploy after any env change). `vercel.json` registers a daily cron.

5. **Keep history complete** — Spotify's `recently-played` only returns the last 50 plays, so
   history is polled, not pushed. While the site is open it syncs every 2 min on its own (no
   button). For when it's closed, the GitHub Actions workflow (`.github/workflows/sync.yml`)
   polls every 5 min — enable it by adding two **repo secrets** (Settings → Secrets and
   variables → Actions): `APP_URL` (your prod origin) and `CRON_SECRET` (same as above).

See `docs/ARCHITECTURE.md` and `docs/GOTCHAS.md` for the full design and gotchas.

## For contributors / AI agents

- `CLAUDE.md` — project context, rules, Next 16 gotchas. **Read first.**
- `AGENTS.md` — working loop, personas, Next 16 API deltas.
- `docs/ARCHITECTURE.md` — layers, auth, tasks.
- `docs/FEATURES.md` — exact behavior/algorithms (the product value).
- `docs/ROADMAP.md` — prioritized backlog (from the prototype's `future.txt`).
- `docs/CONVENTIONS.md` — theme palette + code style.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Auth.js v5 (Spotify).
