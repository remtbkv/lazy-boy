// /usage is the admin's page (PLAN.md §6.2 layer 7, §12.2): it reads every user's telemetry, so a
// signed-in friend gets a 404 before any read. The authz suite's friend cells never reach this
// check: its friends run under SIGNUPS=owner and requirePageUser refuses them first. Under
// SIGNUPS=invite (Phase 4a) the gate lets a friend through and `if (!user.admin) notFound()` is the
// only thing left, so this pins it with the gate's answer for each.
import { beforeEach, describe, expect, it, vi } from "vitest";

const w = vi.hoisted(() => ({ gate: null as null | { uid: string; admin: boolean }, reads: [] as string[] }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/lib/require-user", () => ({ requirePageUser: async () => w.gate }));
vi.mock("@/app/(app)/usage/telemetry", () => ({
  loadUsageTelemetry: async (_days: number, adminUid: string) => {
    w.reads.push(`telemetry:${adminUid}`);
    return {
      ledger: [],
      client: { pages: [], opens: [], errors: [] },
      spotifyCalls: [],
      quotaWindows: [],
      budget: [],
      down: { ledger: false, client: false, spotifyCalls: false, quotaWindows: false, budget: false },
    };
  },
}));
vi.mock("@/lib/capture-read", () => ({
  readCapture: async (uid: string) => {
    w.reads.push(`capture:${uid}`);
    return { health: null };
  },
}));
vi.mock("@/lib/tz", () => ({ tzOffsetMinutes: async () => 0 }));

import { ownerStore, ownerUid } from "../owner-store";

const { default: UsagePage } = await import("@/app/(app)/usage/page");

beforeEach(() => {
  w.reads = [];
  ownerStore(); // the admin's database named, as his identity read would
});

describe("/usage under SIGNUPS=invite", () => {
  it("a friend past the gate gets a 404 before any read", async () => {
    w.gate = { uid: "ffffffffffff", admin: false };
    await expect(UsagePage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(w.reads).toEqual([]);
  });

  it("the admin gets the page, read for him", async () => {
    w.gate = { uid: ownerUid(), admin: true };
    await expect(UsagePage()).resolves.toBeTruthy();
    expect(w.reads.sort()).toEqual([`capture:${ownerUid()}`, `telemetry:${ownerUid()}`]);
  });
});
