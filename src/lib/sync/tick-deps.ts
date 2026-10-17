import "server-only";
import { after } from "next/server";
import { tokenForTick } from "@/lib/auth";
import { cronCaller } from "@/lib/cron-auth";
import { forUserAt, type UserStore } from "@/lib/db";
import { signupsMode } from "@/lib/identity";
import { recordRecentPlays } from "@/lib/sync/history";
import { syncLibrary } from "@/lib/sync/library";
import type { StepStore } from "@/lib/sync/step";
import { appQueue, PHASE3_TICK, type TickDeps } from "@/lib/sync/tick";

// The tick's production wiring (multi-user PLAN §7.2): /api/cron/sync and /api/sync run
// sync/tick.ts with these, the tests with their own (tests/isolation/tick-harness.ts).

// A background rescan's pause between playlist fetches, under Spotify's 30-second limit
// (playlists-sync.ts paces the client's kick the same way).
const RESCAN_PACE_MS = 150;

/** Phase 1's UserStore as the step's store: the probe in the user's `meta`, a harvest recorded
 *  as the single-user sync recorded it, the rescan as syncLibrary with the tick's deadline. */
export function stepStoreOf(store: UserStore): StepStore {
  return {
    readProbe: () => store.readProbe(),
    writeProbe: (p) => store.writeProbe(p),
    recordHarvest: async (plays, sp) => {
      const added = await recordRecentPlays(sp, store, plays);
      // The read ledger's attribution for the store's dominant traffic, as the single-user tick
      // recorded it: which of the two costs a harvest paid depends on whether it landed a play.
      void store.ledgerSyncCall(added > 0 ? "sync_tick_landed" : "sync_tick_steady", added);
      return { added };
    },
    rescanLibrary: (sp, deadline) => syncLibrary(sp, store, undefined, { paceMs: RESCAN_PACE_MS, deadline }),
  };
}

/** The live dependencies. A claimed user's store is opened at the db_name the claim read from
 *  their users row, the same row that leased them; the open's owner check stands behind it. */
export function liveTickDeps(dailyChores: TickDeps["dailyChores"] = async () => {}): TickDeps {
  return {
    now: Date.now,
    caller: cronCaller,
    queue: appQueue,
    storeFor: (u) => stepStoreOf(forUserAt(u.uid, u.dbName)),
    tokenFor: tokenForTick,
    after: (work) => after(work),
    dailyChores,
    config: { ...PHASE3_TICK, signups: signupsMode() },
  };
}
