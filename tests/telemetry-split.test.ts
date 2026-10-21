// Two stores (docs/STORE_MIGRATION.md §6): the app's data on the core client, the three log
// tables (api_log, client_metrics, usage_ledger) on the telemetry client. Here both are local
// files, so every row can be looked up where it should — and should not — have landed.
import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";

const telemetryUrl = await vi.hoisted(async () => {
  // setup.ts already pointed TURSO_DATABASE_URL at this process's core file; the telemetry
  // file sits beside it. Hoisted so it is set before db.ts reads the env at import.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const u = `file:${path.join(mkdtempSync(path.join(tmpdir(), "lazyboy-tel-")), "telemetry.db")}`;
  process.env.TELEMETRY_DATABASE_URL = u;
  return u;
});

import {
  getApiLogSummary,
  getClientLoadSpeed,
  ledgerAdd,
  ledgerSet,
  logSpotifyRequest,
  readLedger,
  recordClientMetrics,
} from "@/lib/db";
import { ownerStore } from "./owner-store";

const store = ownerStore();

const CORE_TABLES = ["tracks", "plays", "contexts", "meta", "playlists", "playlist_tracks", "saved_tracks"];
const TELEMETRY_TABLES = ["api_log", "client_metrics", "usage_ledger"];

async function tablesIn(url: string): Promise<{ names: Set<string>; count: (t: string) => Promise<number> }> {
  const c = createClient({ url, intMode: "number" });
  const res = await c.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  return {
    names: new Set(res.rows.map((r) => String(r.name))),
    count: async (t) => Number((await c.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0].n),
  };
}

describe("two stores: core and telemetry", () => {
  it("telemetry rows land in the telemetry file and core rows in the core file", async () => {
    const coreUrl = process.env.TURSO_DATABASE_URL!;
    expect(coreUrl).not.toBe(telemetryUrl);

    await store.recordPlays([
      {
        trackId: "t1",
        name: "One",
        artist: "A",
        uri: "spotify:track:t1",
        album: null,
        albumImage: null,
        durationMs: 180_000,
        playedAt: new Date(Date.now() - 3_600_000).toISOString(),
        contextType: null,
        contextUri: null,
      },
    ]);
    await store.setUserTzOffset(0);
    await store.rebuildHomePayload();
    await logSpotifyRequest({ method: "GET", path: "/me/player", status: 200, retryAfter: null, source: "test" });
    await ledgerAdd("day_strip", 12);
    await ledgerSet("2026-10-01", "_platform_total", 99);
    await recordClientMetrics([{ session: "s", page: "/home", event: "pageview" }]);

    const core = await tablesIn(coreUrl);
    const tel = await tablesIn(telemetryUrl);

    for (const t of CORE_TABLES) expect(core.names.has(t), `core has ${t}`).toBe(true);
    for (const t of TELEMETRY_TABLES) expect(core.names.has(t), `core lacks ${t}`).toBe(false);
    for (const t of TELEMETRY_TABLES) expect(tel.names.has(t), `telemetry has ${t}`).toBe(true);
    for (const t of CORE_TABLES) expect(tel.names.has(t), `telemetry lacks ${t}`).toBe(false);

    expect(await core.count("plays")).toBe(1);
    expect(await tel.count("api_log")).toBe(1);
    expect(await tel.count("usage_ledger")).toBeGreaterThanOrEqual(2);
    expect(await tel.count("client_metrics")).toBe(1);

    // And the reads come back from the same place.
    expect((await getApiLogSummary()).windows.find((w) => w.seconds === 60)!.calls).toBe(1);
    expect((await readLedger(30)).some((r) => r.reader === "_platform_total")).toBe(true);
    expect((await getClientLoadSpeed()).pages.find((p) => p.page === "/home")?.views).toBe(1);
    expect((await store.getHomePayload())?.allTime).toBeTruthy();
  });

  it("the telemetry store gets the api_log.source column", async () => {
    const c = createClient({ url: telemetryUrl, intMode: "number" });
    const cols = (await c.execute("PRAGMA table_info(api_log)")).rows.map((r) => String(r.name));
    expect(cols).toContain("source");
  });
});
