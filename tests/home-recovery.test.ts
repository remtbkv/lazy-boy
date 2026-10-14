// Home's failure holes (burn review 2026-10-03, U1/U2): each case below used to leave the
// view broken for the rest of the visit after ONE transient error.
import { describe, expect, it } from "vitest";
import {
  persistableDay,
  settleAction,
  settleDayFetch,
  settlePayloads,
} from "@/lib/home-recovery";

const lib = { tracks: [["a"]] };
const hist = { tracks: [["b"]] };
const empty = { tracks: [] };

describe("settleDayFetch (U1: day click)", () => {
  it("a rejected day fetch restores the previous selection", () => {
    expect(settleDayFetch(3, 3, "2026-10-12", { ok: false })).toEqual({
      kind: "restore",
      selected: "2026-10-12",
    });
  });
  it("a success shows the rows", () => {
    expect(settleDayFetch(3, 3, "x", { ok: true, rows: [1] })).toEqual({ kind: "show", rows: [1] });
  });
  it("a superseded fetch changes nothing, success or failure", () => {
    expect(settleDayFetch(3, 4, "x", { ok: false })).toEqual({ kind: "superseded" });
    expect(settleDayFetch(3, 4, "x", { ok: true, rows: [1] })).toEqual({ kind: "superseded" });
  });
});

describe("settlePayloads (U1: search library half)", () => {
  it("a failed library half clears its ref and arms a retry", () => {
    const s = settlePayloads(null, hist);
    expect(s).toMatchObject({ status: "memory", clearLib: true, clearHist: false, armRetry: true });
    expect(s.playsKnown).toBe(true);
  });
  it("a failed history half clears its ref, arms a retry and withholds 'never played'", () => {
    expect(settlePayloads(lib, null)).toMatchObject({
      status: "memory",
      clearLib: false,
      clearHist: true,
      armRetry: true,
      build: true,
      playsKnown: false,
    });
  });
  it("both failed: fallback, both refs cleared", () => {
    expect(settlePayloads(null, null)).toMatchObject({
      status: "fallback",
      clearLib: true,
      clearHist: true,
      armRetry: true,
      build: false,
    });
  });
  it("failed library + empty history: fallback, and the library is still retried", () => {
    expect(settlePayloads(null, empty)).toMatchObject({
      status: "fallback",
      clearLib: true,
      armRetry: true,
    });
  });
  it("both empty (cold store): fallback, nothing cleared", () => {
    expect(settlePayloads(empty, empty)).toMatchObject({
      status: "fallback",
      clearLib: false,
      clearHist: false,
      armRetry: false,
      build: false,
    });
  });
  it("both in: memory, no retry", () => {
    expect(settlePayloads(lib, hist)).toEqual({
      status: "memory",
      clearLib: false,
      clearHist: false,
      armRetry: false,
      build: true,
      playsKnown: true,
    });
  });
});

describe("settleAction (U1: dock actions)", () => {
  it("passes an action's own result through", async () => {
    expect(await settleAction(Promise.resolve({ ok: true as const, name: "Q" }))).toEqual({
      ok: true,
      name: "Q",
    });
    expect(await settleAction(Promise.resolve({ ok: false as const, error: "no device" }))).toEqual({
      ok: false,
      error: "no device",
    });
  });
  it("maps a transport rejection to {ok:false} instead of throwing", async () => {
    const r = await settleAction(Promise.reject(new Error("Server Action not found")));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/try again/);
  });
});

describe("persistableDay (U2)", () => {
  // 2026-10-14 15:00 local in UTC-4 = 19:00Z.
  const now = Date.parse("2026-10-14T19:00:00Z");
  const ny = -240;
  it("today and yesterday are live — never persisted", () => {
    expect(persistableDay("2026-10-14", now, ny)).toBe(false);
    expect(persistableDay("2026-10-13", now, ny)).toBe(false);
  });
  it("today-2 and older are frozen — persisted", () => {
    expect(persistableDay("2026-10-12", now, ny)).toBe(true);
    expect(persistableDay("2026-10-11", now, ny)).toBe(true);
  });
  it("uses the LOCAL day: 01:00Z on the 15th is still the 14th in New York", () => {
    const late = Date.parse("2026-10-15T01:00:00Z");
    expect(persistableDay("2026-10-13", late, ny)).toBe(false);
    expect(persistableDay("2026-10-13", late, 0)).toBe(true);
  });
  it("the all-time view is never persisted", () => {
    expect(persistableDay("all", now, ny)).toBe(false);
  });
});
