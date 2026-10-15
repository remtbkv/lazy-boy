import { spotifyAccessTokenFor } from "@/lib/auth";
import { requireUser } from "@/lib/require-user";
import { SpotifyError, spotifyClient, spotifyCooldownMs } from "@/lib/spotify";
import { getContextName, recordContexts } from "@/lib/db";

// Live "what's playing right now". Returns { playing: null } when nothing is
// actively playing or there's no active device — never stale/last-played data —
// and a 503 when it can't tell (see the catch).
// Resolves the playback context (playlist/album name) once and caches it, so the
// poll doesn't re-hit Spotify for a name it already knows.

// Every reply also carries this deployment's build id. It rides the 6s poll the app
// already makes — no extra endpoint, no extra request — and lets a tab left open across a
// deploy notice its bundle is stale and reload itself (src/lib/build-skew.ts,
// docs/GOTCHAS.md "Deployment skew + stale tabs").
const reply = (playing: unknown) =>
  Response.json({ playing, build: process.env.NEXT_PUBLIC_BUILD_ID });

export async function GET() {
  const user = await requireUser();
  // The identity check could not run: "could not tell" (a non-200 the poll ignores), never
  // "nothing playing", which would make Home finish the current song.
  if (user.kind === "unavailable") {
    return Response.json({ error: "unavailable", retry: true }, { status: 503 });
  }
  // Short-circuited: this route is public and polled every 6s, so a signed-out caller must
  // cost zero DB reads (it did before the token moved off the session — keep it that way).
  const accessToken =
    user.kind === "allowed" && user.gate.canCallSpotify ? await spotifyAccessTokenFor(user.gate.uid) : undefined;
  // Deliberately 200 {playing:null}, not 401: the poll runs every 6s, and a just-expired
  // session would otherwise error-spam the console until re-login. Nothing leaks — the
  // signed-out answer is indistinguishable from "nothing playing".
  if (!accessToken) {
    return reply(null);
  }
  try {
    const sp = spotifyClient(accessToken, false, "now-playing");
    const playing = await sp.currentlyPlaying();
    if (!playing) return reply(null);

    let context: { name: string; type: string } | null = null;
    if (playing.context) {
      const cached = await getContextName(playing.context.uri);
      if (cached) {
        context = { name: cached, type: playing.context.type };
      } else if (cached === undefined) {
        // Never cached — resolve once and cache. `null` (negative-cached, known 403/404)
        // deliberately falls through with no name and no Spotify call: re-hitting it every
        // 6s poll is what the negative cache exists to prevent.
        const resolved = await sp.contextName(playing.context.uri);
        if (resolved) {
          await recordContexts([{ uri: playing.context.uri, name: resolved.name, type: resolved.type }]);
          context = { name: resolved.name, type: resolved.type };
        } else {
          // Cache the FAILURE too. Only the sync path wrote negative rows, so a 403'd
          // context playing right now (a friend's playlist, dev mode) cost ~2 forbidden
          // Spotify calls per 6s poll until a sync happened to carry the URI — ~1,200
          // calls/hour into a dead endpoint (audit 2026-08-19, T2.14).
          await recordContexts([
            { uri: playing.context.uri, name: null, type: playing.context.type },
          ]);
        }
      }
    }

    // Spread first, then overwrite the raw {type,uri} context with the resolved
    // {name,type} one (later keys win).
    return reply({ ...playing, context });
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
