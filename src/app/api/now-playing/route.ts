import { spotifyAccessTokenFor } from "@/lib/auth";
import { requireUser } from "@/lib/require-user";
import { SpotifyError, spotifyClient, spotifyCooldownMs } from "@/lib/spotify";
import { forUser } from "@/lib/db";
import { currentMode } from "@/lib/budget/mode";
import { NOW_PLAYING_MIN_POLL_MS } from "@/lib/budget/modes";
import { meteredBody } from "@/lib/budget/request-meter";
import { memoizedNowPlaying, rememberNowPlaying } from "@/lib/now-playing-memo";

// Live "what's playing right now". Returns { playing: null } when nothing is
// actively playing or there's no active device — never stale/last-played data —
// and a 503 when it can't tell (see the catch).
// Resolves the playback context (playlist/album name) once and caches it, so the
// poll doesn't re-hit Spotify for a name it already knows.

// Every reply also carries this deployment's build id. It rides the 6s poll the app
// already makes — no extra endpoint, no extra request — and lets a tab left open across a
// deploy notice its bundle is stale and reload itself (src/lib/build-skew.ts,
// docs/GOTCHAS.md "Deployment skew + stale tabs").
// A signed-in answer names its user (`u`): every (app) page polls this, so it is how a tab
// rendered for one user learns that the browser's cookie now names another (a sign-in in
// another tab) instead of showing, caching and relaying that user's player under the first
// one's names (multi-user PLAN §6.2 layer 6; user-storage.ts namesAnotherUser).
// `minPollMs` is the budget's floor under the poller's cadence (0 = its own; CAPACITY §6,
// src/lib/budget/modes.ts). The body is metered toward Fast Origin Transfer.
const reply = (playing: unknown, u?: string, minPollMs = 0) =>
  new Response(
    meteredBody(JSON.stringify({ playing, build: process.env.NEXT_PUBLIC_BUILD_ID, minPollMs, ...(u ? { u } : {}) })),
    { headers: { "Content-Type": "application/json" } },
  );

export async function GET(req?: Request) {
  const user = await requireUser();
  // The identity check could not run: "could not tell" (a non-200 the poll ignores), never
  // "nothing playing", which would make Home finish the current song.
  if (user.kind === "unavailable") {
    return Response.json({ error: "unavailable", retry: true }, { status: 503 });
  }
  // Short-circuited: this route is public and polled every 6s, so a signed-out caller must
  // cost zero DB reads (it did before the token moved off the session — keep it that way).
  const accessToken = user.kind === "allowed" ? await spotifyAccessTokenFor(user.gate.uid) : undefined;
  // Deliberately 200 {playing:null}, not 401: the poll runs every 6s, and a just-expired
  // session would otherwise error-spam the console until re-login. Nothing leaks — the
  // signed-out answer is indistinguishable from "nothing playing".
  if (user.kind !== "allowed") return reply(null);
  const uid = user.gate.uid;
  if (!accessToken) return reply(null, uid);
  const store = forUser(uid);
  // The same user's answer from the last ~5 s, so their tabs share one Spotify call (§6.6).
  const now = Date.now();
  // Read beside the Spotify call, not before it: the mode's cache misses once per 10 minutes. A
  // memoized answer carries the floor too, or a tab's poller would drop it for one reply.
  const floor = currentMode().then((m) => NOW_PLAYING_MIN_POLL_MS[m]);
  // `?fresh=1`: the poll after an in-app play, pause or Save Queue walk, and the re-ask that
  // confirms an empty answer. The memo's answer predates what the tab is checking, so it reads
  // Spotify (and still writes the memo). Bounded by user actions (code review 0156 H2).
  const fresh = !!req && new URL(req.url).searchParams.get("fresh") === "1";
  const memo = fresh ? null : memoizedNowPlaying(uid, now);
  if (memo) return reply(memo.playing, uid, await floor);
  try {
    const sp = spotifyClient(uid, accessToken, false, "now-playing");
    const playing = await sp.currentlyPlaying();
    // The sample is as old as the answer, not as the request: stamped with `now`, a replay ran the
    // call's latency ahead (code review 0156 L-f).
    const sampledAt = Date.now();
    // An empty answer is memoized too: an idle player is the commonest state for a tab left open,
    // and R13's bound has to cover it (code review 0158 finding 3). Spotify's player has answered
    // empty mid-playback, but the tab confirms one with a fresh re-ask, which skips this read.
    if (!playing) {
      rememberNowPlaying(uid, sampledAt, null);
      return reply(null, uid, await floor);
    }

    let context: { name: string; type: string } | null = null;
    if (playing.context) {
      const cached = await store.getContextName(playing.context.uri);
      if (cached) {
        context = { name: cached, type: playing.context.type };
      } else if (cached === undefined) {
        // Never cached — resolve once and cache. `null` (negative-cached, known 403/404)
        // deliberately falls through with no name and no Spotify call: re-hitting it every
        // 6s poll is what the negative cache exists to prevent.
        const resolved = await sp.contextName(playing.context.uri);
        if (resolved) {
          await store.recordContexts([{ uri: playing.context.uri, name: resolved.name, type: resolved.type }]);
          context = { name: resolved.name, type: resolved.type };
        } else {
          // Cache the FAILURE too. Only the sync path wrote negative rows, so a 403'd
          // context playing right now (a friend's playlist, dev mode) cost ~2 forbidden
          // Spotify calls per 6s poll until a sync happened to carry the URI — ~1,200
          // calls/hour into a dead endpoint (audit 2026-08-19, T2.14).
          await store.recordContexts([
            { uri: playing.context.uri, name: null, type: playing.context.type },
          ]);
        }
      }
    }

    // Spread first, then overwrite the raw {type,uri} context with the resolved
    // {name,type} one (later keys win).
    rememberNowPlaying(uid, sampledAt, { ...playing, context });
    return reply({ ...playing, context }, uid, await floor);
  } catch (e) {
    // Rate-limited: say so, with how long to wait, so the poller backs off for that long
    // instead of asking again on its steady cadence (src/lib/now-playing-poll.ts).
    if (e instanceof SpotifyError && e.status === 429) {
      const retryAfterS = Math.max(1, Math.ceil(spotifyCooldownMs() / 1000));
      return Response.json(
        { error: "rate-limited" },
        { status: 429, headers: { "Retry-After": String(retryAfterS) } },
      );
    }
    // A failure (Spotify 429/timeout, a store blip resolving the context) is NOT "nothing
    // playing": a 200 null here made Home finish() the current song and mint a provisional
    // play mid-song. Non-200 tells the poll to keep its last state (pollOnce skips !res.ok).
    // "No active device" never lands here — Spotify answers it 204 → null above.
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
