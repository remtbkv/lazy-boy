// Log out and Disconnect as ruled (RULINGS Oct 15 1:17 PM and 1:33 PM; PLAN.md §5.4): Log out signs
// the person out of every browser and stops recording their listening, Rem included, and the page
// after it says so; Disconnect needs the typed word and a sign-in within ten minutes, never runs for
// the admin, and its page sends the person to spotify.com/account/apps.
import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnect, disconnectRefusal, logOutEverywhere, logOutFrom } from "@/lib/account";
import { forUser } from "@/lib/db";
import { mintUid } from "@/lib/identity";
import { readIdentity } from "@/lib/identity-read";
import type { Gate } from "@/lib/session-gate";
import { createTokenCore } from "@/lib/token-core";
import { appTokenStore } from "@/lib/token-store-app";
import { freshAppDb, seedUser } from "./harness";

const A = process.env.OWNER_UID as string; // Rem: forUser maps his uid to the simulated `lazyboy`
const B = "bbbbbbbbbbbb";
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const gate = (uid: string, admin = false): Gate => ({ uid: mintUid(uid), admin, canCallSpotify: true });
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number> = {}) => (await db.raw().execute({ sql, args })).rows;

beforeEach(async () => {
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "invite");
  const store = appTokenStore();
  await store.get(A as never);
  await seedUser(db.raw(), { uid: A, status: "active", admin: true });
  await seedUser(db.raw(), { uid: B, status: "active" });
  for (const u of [A, B]) await store.set(u as never, { accessToken: `at-${u}`, refreshToken: `rt-${u}`, expiresAt: 4_000_000_000 });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Log out", () => {
  it("signs B out of every browser and stops capture, touching nobody else", async () => {
    const cookie = { uid: B, ep: 0, auth_time: NOW_S - 60 };
    expect((await readIdentity(cookie)).kind).toBe("allowed");
    await logOutEverywhere(gate(B));
    // A cookie copied before Log out is refused at its next request (the epoch moved).
    expect(await readIdentity(cookie)).toEqual({ kind: "refused", reason: "epoch" });
    // No token row: the tick's token read finds nothing, so the step makes no Spotify call.
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await createTokenCore(appTokenStore()).tokenForTick(mintUid(B))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // B's account and data stay: Log out deletes nothing.
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: B }))[0].status).toBe("active");
    // Rem's session and token are untouched.
    expect((await readIdentity({ uid: A, ep: 0, auth_time: NOW_S - 60 })).kind).toBe("allowed");
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: A }))[0].n).toBe(1);
  });

  it("does the same for Rem, and nothing of his is deleted", async () => {
    // Phase 2's week: his plaintext row still sits in `lazyboy` beside the token of record.
    const rem = forUser(mintUid(A));
    await rem.setSpotifyTokens({ accessToken: "at-plain", refreshToken: "rt-plain", expiresAt: 4_000_000_000 });
    await logOutEverywhere(gate(A, true));
    expect(await readIdentity({ uid: A, ep: 0, auth_time: NOW_S - 60 })).toEqual({ kind: "refused", reason: "epoch" });
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: A }))[0].n).toBe(0);
    // The plaintext row goes too, so the cron's "no token" alarm sees him signed out.
    expect(await rem.getSpotifyTokens()).toBeNull();
    expect((await q("SELECT status, db_name, is_admin FROM users WHERE uid = :u", { u: A }))[0]).toEqual({ status: "active", db_name: "lazyboy", is_admin: 1 });
    // A fresh sign-in (epoch 1 on its new cookie) is allowed again and writes a new token row.
    expect((await readIdentity({ uid: A, ep: 1, auth_time: NOW_S })).kind).toBe("allowed");
    await appTokenStore().set(A as never, { accessToken: "at2", refreshToken: "rt2", expiresAt: 4_000_000_000 });
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: A }))[0].n).toBe(1);
  });

  it("ends nothing and throws when the identity check could not run, so no page claims it did", async () => {
    // Lane 09's review: Log out used to sign this browser out and land on /signed-out ("every
    // browser", "stopped recording") even when the check behind it could not run, leaving the other
    // browsers signed in and the tick recording.
    await expect(logOutFrom({ kind: "unavailable" })).rejects.toThrow();
    expect((await q("SELECT session_epoch FROM users WHERE uid = :u", { u: B }))[0].session_epoch).toBe(0);
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: B }))[0].n).toBe(1);
    await logOutFrom({ kind: "refused" });
    expect((await q("SELECT count(*) AS n FROM user_tokens"))[0].n).toBe(2);
    await logOutFrom({ kind: "allowed", gate: gate(B) });
    expect((await q("SELECT session_epoch FROM users WHERE uid = :u", { u: B }))[0].session_epoch).toBe(1);
    expect((await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: B }))[0].n).toBe(0);
  });

  it("the page after it says recording stopped and how to resume", async () => {
    const { default: Page } = await import("@/app/(auth)/signed-out/page");
    const text = renderToStaticMarkup(createElement(Page)).replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'");
    expect(text).toContain("logged out of Lazy Boy on every browser");
    expect(text).toContain("stopped recording your listening history");
    expect(text).toContain("sign in");
    expect(text).toContain("your last 50");
  });
});

describe("Disconnect", () => {
  const fresh = { typed: "disconnect", authTime: NOW_S - 60, nowMs: NOW };
  it("needs the word and a sign-in within ten minutes, and is never the admin's", () => {
    expect(disconnectRefusal(gate(B), fresh)).toBeNull();
    expect(disconnectRefusal(gate(B), { ...fresh, typed: " Disconnect " })).toBeNull();
    expect(disconnectRefusal(gate(B), { ...fresh, typed: "delete" })).toBe("word");
    expect(disconnectRefusal(gate(B), { ...fresh, authTime: NOW_S - 601 })).toBe("stale");
    expect(disconnectRefusal(gate(B), { ...fresh, authTime: undefined })).toBe("stale");
    expect(disconnectRefusal(gate(A, true), fresh)).toBe("admin");
  });

  it("runs the deletion job only when allowed", async () => {
    const run = vi.fn(async () => ({ kind: "done" as const }));
    expect(await disconnect(gate(A, true), fresh, run)).toEqual({ ok: false, reason: "admin" });
    expect(await disconnect(gate(B), { ...fresh, authTime: NOW_S - 3600 }, run)).toEqual({ ok: false, reason: "stale" });
    expect(run).not.toHaveBeenCalled();
    expect(await disconnect(gate(B), fresh, run)).toEqual({ ok: true, outcome: { kind: "done" } });
    expect(run).toHaveBeenCalledWith(B);
  });

  it("the page after it tells the person to remove the app at Spotify", async () => {
    const { default: Page } = await import("@/app/(auth)/disconnected/page");
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain('href="https://www.spotify.com/account/apps/"');
    expect(html).toContain("within five");
  });
});
