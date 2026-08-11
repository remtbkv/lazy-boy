import "server-only";
import { spotifyClient } from "@/lib/spotify";
import {
  recordPlays,
  recordContexts,
  unresolvedContextUris,
  unseenContexts,
  getContextsFullCheckAt,
  setContextsFullCheckAt,
  getSpotifyCooldownUntil,
  hasHomePayload,
  rebuildHomePayload,
  type PlayRecord,
  type ContextRecord,
} from "@/lib/db";

// How often the full unresolved-context pass runs. It is the only reader that can find a
// negative-cached context whose 30-day re-check lapsed, and it is a full plays scan, so it
// runs daily instead of on every sync call — the per-call check is batch-bounded.
const CONTEXTS_FULL_CHECK_MS = 24 * 60 * 60 * 1000;

type Spotify = ReturnType<typeof spotifyClient>;

// Core listen-history sync, shared by the on-load /api/sync (session-bound client)
// and the /api/cron/sync backstop (stored-token client).
// Pulls the last ~50 plays into the local store and resolves any new playback
// contexts (playlist/album names). recordPlays() stamps `last_sync`.
export async function syncRecentPlays(
  sp: Spotify,
): Promise<{ added: number; skipped?: string }> {
  // Spotify handed out a rate-limit ban recently — don't poke it again until the window
  // passes (persisted, so serverless ticks honor it across invocations). Re-poking a
  // banned endpoint is what risks turning a brief throttle into a long block.
  if (Date.now() < (await getSpotifyCooldownUntil())) {
    return { added: 0, skipped: "cooldown" };
  }
  const recent = await sp.recentlyPlayed(50);
  const rows: PlayRecord[] = recent.map((r) => ({
    trackId: r.track.id,
    name: r.track.title,
    artist: r.track.artist,
    uri: r.track.uri,
    album: r.track.album ?? null,
    albumImage: r.track.albumImage ?? null,
    durationMs: r.track.durationMs ?? null,
    playedAt: r.playedAt,
    contextType: r.contextType,
    contextUri: r.contextUri,
  }));
  const added = await recordPlays(rows);

  // Resolve names for any contexts we don't have yet (cap per sync to be gentle).
  // Per-call: only the batch's own URIs are checked (a new context can't enter any other
  // way) — an indexed read over ≤50 URIs. Once a day the full pass runs instead, which is
  // what re-checks negative-cached names whose 30-day window lapsed.
  const fullDue = Date.now() - (await getContextsFullCheckAt()) > CONTEXTS_FULL_CHECK_MS;
  const cands = rows
    .filter((r) => r.contextUri !== null)
    .map((r) => ({ uri: r.contextUri as string, type: r.contextType ?? "" }));
  const pending = (fullDue ? await unresolvedContextUris() : await unseenContexts(cands)).slice(
    0,
    20,
  );
  const resolved: ContextRecord[] = [];
  // Resolve in small concurrent batches: faster than one-at-a-time, but still gentle on
  // Spotify's rate limit (the client's shared cooldown backs the whole batch off on a 429).
  // contextName returns null only for permanent failures (403/404) — record those with a
  // null name as a negative cache, so dead contexts stop being re-fetched on every sync.
  // Transient failures throw; those stay unresolved and retry next sync.
  for (let i = 0; i < pending.length; i += 4) {
    const batch = await Promise.all(
      pending.slice(i, i + 4).map(async (c) => {
        try {
          const r = await sp.contextName(c.uri);
          return r
            ? { uri: c.uri, name: r.name, type: r.type }
            : { uri: c.uri, name: null, type: c.type };
        } catch {
          return null; // transient — leave unresolved for the next sync
        }
      }),
    );
    for (const r of batch) if (r) resolved.push(r);
  }
  await recordContexts(resolved);
  // Stamp only after a completed pass, so a throw above retries it on the next call.
  if (fullDue) await setContextsFullCheckAt();

  // Home renders from one materialized row (db.ts, "The Home payload"), so the sync that
  // changes the data is what has to rewrite it. This is the single point both triggers pass
  // through — /api/sync (open tab) and /api/cron/sync (the ~2-min pinger), plus
  // refreshHistoryAction — so the rebuild belongs here and not in either route; adding it per
  // route would mean two places to keep in step and one of them eventually missed.
  // Rebuilt when plays landed (the stored payload is now wrong) and when the row is simply
  // absent — a store nothing has synced into yet, or the first tick after a deploy that moved
  // the payload's shape. A steady tick (nothing new, row present) pays one indexed meta read
  // and no writes. AFTER recordContexts so newly resolved names are in the payload's "From".
  // Never fatal: the payload is a cache Home computes inline when it's missing, and a
  // scheduler that gets a 500 here would eventually disable itself over a failure that cost
  // nothing.
  try {
    if (added > 0 || !(await hasHomePayload())) await rebuildHomePayload();
  } catch (e) {
    console.error("[home-payload] rebuild after sync failed", e);
  }

  return { added };
}
