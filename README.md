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

## Deployment

Runs on Vercel. The listen-history + token store is **libSQL/Turso** (`TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN`); locally it falls back to a SQLite file when those are unset. History is
kept current by a GitHub Actions cron (`.github/workflows/sync.yml`, every 30 min) plus an
on-app-load sync. See `docs/ARCHITECTURE.md` and `docs/GOTCHAS.md` for the full setup and the
`.vercel.app` / `AUTH_URL` / redirect-URI details.

## For contributors / AI agents

- `CLAUDE.md` — project context, rules, Next 16 gotchas. **Read first.**
- `AGENTS.md` — working loop, personas, Next 16 API deltas.
- `docs/ARCHITECTURE.md` — layers, auth, tasks.
- `docs/FEATURES.md` — exact behavior/algorithms (the product value).
- `docs/ROADMAP.md` — prioritized backlog (from the prototype's `future.txt`).
- `docs/CONVENTIONS.md` — theme palette + code style.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Auth.js v5 (Spotify).
