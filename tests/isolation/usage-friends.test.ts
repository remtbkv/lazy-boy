// /usage, the admin's page, shows friends' telemetry only aggregated by page template (PLAN.md §6.2
// layer 7, §12.2 "the operator"): a friend's views and timings count in the per-page numbers, but
// none of their individual opens (a timeline of when they used the app) and none of their error
// messages (free text) is listed. Rows with no uid, written before Phase 1 tagged them, are Rem's.
// The check is harness.ts's, which planted-bugs.test.ts also runs against a planted read.
import { describe, expect, it } from "vitest";
import { getClientLoadSpeed, recordClientMetrics } from "@/lib/db";
import { ownerUid } from "../owner-store";
import { expectFriendTelemetryAggregated } from "./harness";

const FRIEND = "ffffffffffff";

describe("getClientLoadSpeed for the admin", () => {
  it("counts a friend's views and errors in the aggregates and lists none of their opens or messages", async () => {
    await expectFriendTelemetryAggregated(ownerUid(), FRIEND, getClientLoadSpeed);
  });

  it("lists the untagged rows from before Phase 1 as Rem's", async () => {
    await recordClientMetrics([{ session: "s-old", page: "/home", event: "pageview", value: null, meta: "pv:o1" }], null);
    const r = await getClientLoadSpeed(ownerUid());
    expect(r.opens.some((o) => o.page === "/home")).toBe(true);
  });
});
