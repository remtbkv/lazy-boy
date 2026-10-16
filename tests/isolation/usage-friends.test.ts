// /usage, the admin's page, shows friends' telemetry only aggregated by page template (PLAN.md §6.2
// layer 7, §12.2 "the operator"): a friend's views and timings count in the per-page numbers, but
// none of their individual opens (a timeline of when they used the app) and none of their error
// messages (free text) is listed. Rows with no uid, written before Phase 1 tagged them, are Rem's.
import { describe, expect, it } from "vitest";
import { getClientLoadSpeed, recordClientMetrics } from "@/lib/db";
import { ownerUid } from "../owner-store";

const FRIEND = "ffffffffffff";

describe("getClientLoadSpeed for the admin", () => {
  it("counts a friend's views and errors in the aggregates and lists none of their opens or messages", async () => {
    const admin = ownerUid();
    const view = (session: string, page: string, pv: string) => [
      { session, page, event: "pageview", value: null, meta: `pv:${pv}` },
      { session, page, event: "fcp", value: 400, meta: `pv:${pv}` },
    ];
    await recordClientMetrics([...view("s-admin", "/home", "a1")], admin);
    await recordClientMetrics(
      [
        ...view("s-friend", "/playlists/[id]", "f1"),
        { session: "s-friend", page: "/playlists/[id]", event: "js-error", value: null, meta: "pv:f1|FRIEND-only error text" },
      ],
      FRIEND,
    );
    await recordClientMetrics([...view("s-old", "/home", "o1")], null);

    const r = await getClientLoadSpeed(admin);
    const playlists = r.pages.find((p) => p.page === "/playlists/[id]");
    expect(playlists?.views).toBe(1);
    expect(playlists?.errors).toBe(1);
    expect(playlists?.stats.fcp?.n).toBe(1);
    expect(r.opens.filter((o) => o.page === "/playlists/[id]")).toEqual([]);
    expect(JSON.stringify(r.errors)).not.toContain("FRIEND-only");
    // Rem's own opens, and the untagged ones from before Phase 1, are listed as before.
    expect(r.opens.filter((o) => o.page === "/home").length).toBeGreaterThanOrEqual(2);
  });
});
