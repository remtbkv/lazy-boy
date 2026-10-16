# What Am I?

Next.js web app which, at its core, fixes an annoying issue in Spotify where "duplicates" aren't properly recognized. There could be the same song but in a different (e.g. deluxe) album by the same artist, and the song will not be flagged as a duplicate. So I personally did not like this and so made a very simple app initially to just "clean" out a playlist by removing all real duplicates. Then added more functionality. Now we're here.

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
   Then paste your Spotify **Client ID** and **Secret** into `.env.local`, and fill in the
   three identity values the comments explain: `SPOTIFY_OWNER_ID` (the id in your Spotify
   profile URL), `OWNER_UID` (generated once) and a dev `TOKEN_KEYS` (generated once; it
   encrypts your Spotify token in `data/app.db`). Everything else is optional.
3. **Make your user row** in the local app database, `data/app.db` (once; re-running changes
   nothing). Until `npm run setup` does this itself:
   ```bash
   node --env-file=.env.local --input-type=module -e "
   import { mkdirSync } from 'node:fs';
   import { createClient } from '@libsql/client';
   import { appSchemaBatches, adminRowStatement } from './src/lib/app-schema.ts';
   mkdirSync('data', { recursive: true });
   const c = createClient({ url: 'file:data/app.db' });
   for (const b of appSchemaBatches(0, 0)) await c.batch(b, 'write');
   await c.execute(adminRowStatement(process.env.OWNER_UID, process.env.SPOTIFY_OWNER_ID, Date.now()));"
   ```
4. **Run it:** `npm run dev`, open http://127.0.0.1:3000, sign in with Spotify. Your first
   sign-in binds your Spotify account to that row.

> Use `127.0.0.1`, not `localhost` — Spotify rejects `localhost` redirect URIs (the app
> bounces you to `127.0.0.1` automatically if you land on `localhost`).

## Deploy (optional)

Only needed if you want an always-on instance that keeps syncing your history while the app is
closed. A hosted instance adds a persistent DB + a scheduler.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/remtbkv/lazy-boy&env=AUTH_SECRET,SPOTIFY_CLIENT_ID,SPOTIFY_CLIENT_SECRET,SPOTIFY_OWNER_ID,OWNER_UID,AUTH_URL,TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,APP_DATABASE_URL,TOKEN_KEYS,CRON_SECRET&envDescription=See%20.env.example%20for%20what%20each%20value%20is)

1. **Database** — two [Turso](https://turso.tech) (libSQL) databases in one group: your data
   (`TURSO_DATABASE_URL`, `turso db show <name> --url`, the `https://` form) and the app
   database `lazyboy-app`, which holds the users and their encrypted Spotify tokens
   (`APP_DATABASE_URL`). One group token reaches both: `turso group tokens create default` →
   `TURSO_AUTH_TOKEN`. Get the CLI to run these comands or just find it somewhere in the site.
   Then, with `OWNER_UID` and `SPOTIFY_OWNER_ID` in `.env.local` and the Turso platform token
   in your Keychain as `lazyboy-turso-platform`:
   ```bash
   node --env-file=.env.local scripts/phase1-meta-keys.mjs --user <OWNER_UID> --apply  # names the data's owner
   node --env-file=.env.local scripts/phase2-app-db.mjs --org <your-turso-org>        # lazyboy-app + your user row
   ```
2. **Vercel env** — set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `AUTH_SECRET`, `SPOTIFY_OWNER_ID`, `OWNER_UID`,
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `APP_DATABASE_URL`, `TOKEN_KEYS`, `CRON_SECRET`
   (`openssl rand -base64 32`), and `AUTH_URL` = your deployed origin (e.g.
   `https://<project-name>.vercel.app`). Generate `TOKEN_KEYS` inside the pipe that sets it,
   so it is never on screen, and keep one copy somewhere safe (a lost key means everyone signs
   in again): `echo "v1:$(openssl rand -base64 32)" | vercel env add TOKEN_KEYS production`.
   Leave `SIGNUPS` unset (only you can sign in).
3. **Spotify** — add `https://<your-domain>/api/auth/callback/spotify` as a Redirect URI.
4. **Keep history current while closed** — point a pinger at `/api/cron/sync` so your
   history keeps syncing when the app isn't open: a systemd timer on an always-on machine
   (this deployment uses one on the Zenbook) or a free [cron-job.org](https://cron-job.org)
   job, every 2 minutes — method GET, one header `Authorization: Bearer <CRON_SECRET>`
   (same value as in Vercel). The URL is your deployed origin + `/api/cron/sync`. Without
   `CRON_SECRET` the endpoint stays closed. When you rotate the secret, update the pinger too
   (`docs/SECURITY.md` lists every copy). Claude can set this up for you :)

For full `AUTH_URL` / redirect-URI / token-coordination details, see `docs/ARCHITECTURE.md` and `docs/GOTCHAS.md`.

## Inviting a friend

Up to four friends (Spotify's development mode allows five accounts, yours included), with
`SIGNUPS=invite` in the deployment's environment:

1. **They request**: send them to `/join`. They enter the e-mail on their Spotify account (a name
   is optional) and accept the privacy policy and terms.
2. **You see the request**: `node scripts/invite.mjs --list`, in your own terminal.
3. **You add them on Spotify**: the developer dashboard → your app → User Management → their
   e-mail.
4. **You approve**: `node scripts/invite.mjs --approve <request id>`. It creates their database and
   prints a join link (good for 14 days) to send them.
5. **They connect** with Spotify, from the browser they requested in or through the link.

A friend leaves with Disconnect, or `node scripts/user.mjs --remove <uid>`; `SIGNUPS=owner` and a
redeploy shuts every friend out at once. The runbooks are in `docs/SECURITY.md`.

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
