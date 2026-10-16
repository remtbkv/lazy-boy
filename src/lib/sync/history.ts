import "server-only";
import { spotifyClient } from "@/lib/spotify";
import { type PlayRecord, type ContextRecord, type UserStore } from "@/lib/db";

// How often the full unresolved-context pass runs. It is the only reader that can find a
// negative-cached context whose 30-day re-check lapsed, and it is a full plays scan, so it
// runs daily instead of on every sync call — the per-call check is batch-bounded.
const CONTEXTS_FULL_CHECK_MS = 24 * 60 * 60 * 1000;

type Spotify = ReturnType<typeof spotifyClient>;

type RecentPlay = Awaited<ReturnType<Spotify["recentlyPlayed"]>>[number];

/** Core listen-history sync: one harvest's plays (the last ~50 from recently-played) into the
 *  user's store, after its Spotify call, which the cron's step makes (multi-user PLAN §7.2
 *  step 3; sync/tick-deps.ts). The plays have natural keys and are safe to repeat; their
 *  playback contexts (playlist/album names) are resolved with the user's own client; the Home
 *  payload is rebuilt. recordPlays() stamps `last_sync`. The step honours the bucket's
 *  cooldown before it calls (step.ts), so nothing here reads one. Returns the plays added. */
export async function recordRecentPlays(sp: Spotify, store: UserStore, recent: RecentPlay[]): Promise<number> {
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
  const added = await store.recordPlays(rows);

  // Resolve names for any contexts we don't have yet (cap per sync to be gentle).
  // Per-call: only the batch's own URIs are checked (a new context can't enter any other
  // way) — an indexed read over ≤50 URIs. Once a day the full pass runs instead, which is
  // what re-checks negative-cached names whose 30-day window lapsed.
  const fullDue = Date.now() - (await store.getContextsFullCheckAt()) > CONTEXTS_FULL_CHECK_MS;
  const cands = rows
    .filter((r) => r.contextUri !== null)
    .map((r) => ({ uri: r.contextUri as string, type: r.contextType ?? "" }));
  const pending = (fullDue ? await store.unresolvedContextUris() : await store.unseenContexts(cands)).slice(
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
  await store.recordContexts(resolved);
  // Stamp only after a completed pass, so a throw above retries it on the next call. The
  // stamp is UNCONDITIONAL on truncation: gating it on `pending.length < 20` (a wave-1
  // attempt to un-starve negative re-checks) meant a standing backlog of ≥20 unresolved
  // URIs re-ran the full-pass scan on EVERY tick instead of daily (wave-2 adversarial
  // review, finding L). The backlog drains at ≤20/day instead — slower, bounded, cheap.
  if (fullDue) await store.setContextsFullCheckAt();

  // Home renders from one materialized row (db.ts, "The Home payload"), so the sync that
  // changes the data is what has to rewrite it. This is the single point both triggers pass
  // through — /api/sync (open tab) and /api/cron/sync (the ~2-min pinger), both by way of the
  // cron's step — so the rebuild belongs here and not in either route; adding it per route
  // would mean two places to keep in step and one of them eventually missed.
  // Rebuilt when plays landed (the stored payload is now wrong) and when the row is simply
  // absent — a store nothing has synced into yet, or the first tick after a deploy that moved
  // the payload's shape. A steady tick (nothing new, row present) pays one indexed meta read
  // and no writes. AFTER recordContexts so newly resolved names are in the payload's "From".
  // Never fatal: the payload is a cache Home computes inline when it's missing, and a
  // scheduler that gets a 500 here would eventually disable itself over a failure that cost
  // nothing.
  try {
    if (added > 0 || !(await store.hasHomePayload())) await store.rebuildHomePayload();
  } catch (e) {
    console.error("[home-payload] rebuild after sync failed", e);
  }

  return added;
}
