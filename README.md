# What Am I?

Next.js web app (claude slop + careful, loving human guidance) which, at its core, fixes an annoying issue in Spotify where "duplicates" aren't properly recognized, as there could be the same song but in a different (e.g. deluxe) album by the same artist, and the song will not be flagged as a duplicate. So I personally did not like this and so made a very simple app initially to just "clean" out a playlist by removing all real duplicates. Then added more functionality. Welcome to Lazy Boy.

Note that due to a web api update from Spotify, developer apps in "development mode" can no longer be used by other users unless manually whitelisted by the creator (me). So if you want to use this you either ask me to whitelist you (don't) or just set it up yourself (easy nowadays). Instructions are below.

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

Merge playlists · Clean playlist (remove already-saved songs) · Save current queue · Listening history · Mirror liked songs into a playlist · Compare another user's playlists (savable song diff). See `docs/FEATURES.md`.

## Deployment

Runs on Vercel. The listen-history + token store is **libSQL/Turso** (`TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`); locally it falls back to a SQLite file when those are unset. History is
kept current by a GitHub Actions cron (`.github/workflows/sync.yml`, every 5 min) plus an
on-app-load sync; set **`CRON_SECRET`** (repo secret + Vercel env) or the cron endpoint
fail-closes and won't run. See `docs/ARCHITECTURE.md` and `docs/GOTCHAS.md` for the full setup
and the `.vercel.app` / `AUTH_URL` / redirect-URI details.

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
