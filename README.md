# What Am I?

Next.js web app (claude slop + careful, loving human guidance) which, at its core, fixes an annoying issue in Spotify where "duplicates" aren't properly recognized. There could be the same song but in a different (e.g. deluxe) album by the same artist, and the song will not be flagged as a duplicate. So I personally did not like this and so made a very simple app initially to just "clean" out a playlist by removing all real duplicates. Then added more functionality. Now we're here.

Note that due to an api update from Spotify, developer apps such as this one can no longer be used by other users unless manually whitelisted by their creator. So if you want to use this, either ask me to whitelist you (don't) or just set it up yourself (easy nowadays). Instructions below.

## Run it locally

No database or hosting required. Listen history saves to a local SQLite file so all you
need is a (free) Spotify developer app.

1. **Make a Spotify app** at https://developer.spotify.com/dashboard, and add this Redirect
   URI to it: `http://127.0.0.1:3000/api/auth/callback/spotify`. Copy the Client ID + Secret.
2. **Install + configure:**
   ```bash
   npm install
   npm run setup     # creates .env.local and generates AUTH_SECRET for you
   ```
   Then paste your Spotify **Client ID** and **Secret** into `.env.local`. That's the only
   thing you must fill in for local use. Everything else is optional (see comments).
3. **Run it:** `npm run dev`, open http://127.0.0.1:3000, sign in with Spotify.

> Use `127.0.0.1`, not `localhost` — Spotify rejects `localhost` redirect URIs (the app
> bounces you to `127.0.0.1` automatically if you land on `localhost`).

## Deploy (optional)

Only needed if you want an always-on instance that keeps syncing your history while the app is
closed. A hosted instance adds a persistent DB + a scheduler.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/remtbkv/lazy-boy&env=AUTH_SECRET,SPOTIFY_CLIENT_ID,SPOTIFY_CLIENT_SECRET,AUTH_URL,TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,CRON_SECRET&envDescription=See%20.env.example%20for%20what%20each%20value%20is)

1. **Database** — create a [Turso](https://turso.tech) (libSQL) DB and set `TURSO_DATABASE_URL`
   (`turso db show <name> --url`) and `TURSO_AUTH_TOKEN` (`turso db tokens create <name>`). Get the CLI to run these comands or just find it somewhere in the site.
2. **Vercel env** — set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `AUTH_SECRET`, the two Turso vars, `CRON_SECRET`
   (`openssl rand -base64 32`), and `AUTH_URL` = your deployed origin (e.g.
   `https://<project-name>.vercel.app`).
3. **Spotify** — add `https://<your-domain>/api/auth/callback/spotify` as a Redirect URI.
4. **Keep history current while closed** — a GitHub Actions cron
   (`.github/workflows/sync.yml`) pings `/api/cron/sync` every 5 min. Add two repo secrets:
   `APP_URL` (your deployed origin) and `CRON_SECRET` (same value as in Vercel). Without
   `CRON_SECRET` the endpoint fail-closes. For a tighter cadence than GitHub's best-effort
   schedule, point any external pinger (cron-job.org, a systemd timer, …) at the same
   `/api/cron/sync` with the bearer secret. Claude can do this for you :)

For full `AUTH_URL` / redirect-URI / token-coordination details, see `docs/ARCHITECTURE.md` and `docs/GOTCHAS.md`.

## Features

- Clean playlist (strip out songs already saved elsewhere)
- Merge and subtract playlists
- Find a song or artist across your playlists, with last-played info included
- Resume a playlist where you last left off
- Save your current queue 
- Compare another user's playlists (savable song diff)
- Listening history (per-day + all-time, searchable)
- Mirror liked songs into a playlist (not shown in app).

See `docs/FEATURES.md`.

## For AI

- `CLAUDE.md` — project context, rules, Next 16 gotchas. **Read first.**
- `AGENTS.md` — working loop, personas, Next 16 API deltas.
- `docs/ARCHITECTURE.md` — layers, auth/token coordination, background tasks, data/caching.
- `docs/GOTCHAS.md` — hard-won traps (Base UI, Spotify API changes, per-instance state). **Read before debugging.**
- `docs/FEATURES.md` — exact behavior/algorithms (the product value).
- `docs/CONVENTIONS.md` — theme palette + code style.
- `docs/SECURITY.md` — token handling + pre-production checklist.
- `docs/ROADMAP.md` — prioritized backlog (from the prototype's `future.txt`).

Each `docs/*.md` ends with a **Related** line linking the others, so you can follow the chain
from whichever one you land in.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Auth.js v5 (Spotify).
