import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { getContextName, recordContexts } from "@/lib/db";

// Live "what's playing right now". Returns { playing: null } when nothing is
// actively playing or there's no active device — never stale/last-played data.
// Resolves the playback context (playlist/album name) once and caches it, so the
// poll doesn't re-hit Spotify for a name it already knows.

// Every reply also carries this deployment's build id. It rides the 6s poll the app
// already makes — no extra endpoint, no extra request — and lets a tab left open across a
// deploy notice its bundle is stale and reload itself (src/lib/build-skew.ts,
// docs/GOTCHAS.md "Deployment skew + stale tabs").
const reply = (playing: unknown) =>
  Response.json({ playing, build: process.env.NEXT_PUBLIC_BUILD_ID });

export async function GET() {
  const session = await auth();
  // Deliberately 200 {playing:null}, not 401: the poll runs every 6s, and a just-expired
  // session would otherwise error-spam the console until re-login. Nothing leaks — the
  // signed-out answer is indistinguishable from "nothing playing".
  if (!session?.accessToken || session.error) {
    return reply(null);
  }
  try {
    const sp = spotifyClient(session.accessToken);
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
        }
      }
    }

    // Spread first, then overwrite the raw {type,uri} context with the resolved
    // {name,type} one (later keys win).
    return reply({ ...playing, context });
  } catch {
    // On any error (no device, transient), show nothing rather than guessing.
    return reply(null);
  }
}
