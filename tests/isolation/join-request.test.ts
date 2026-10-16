// The request form's storage (RULINGS Oct 15 12:46 PM; PLAN.md §12.1): a friend's first visit
// leaves an e-mail (required, the one on their Spotify account) and a name (optional, a filler
// when blank), having been shown the privacy policy and terms and accepted them. A stranger must
// not be able to fill it: the door is shut under SIGNUPS=owner, the open requests are capped, the
// form takes a few requests an hour app-wide, and it closes once five people hold places. It never
// creates a database or calls anything outside the app database.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJoinRequest, JOIN_PENDING_CAP, JOIN_PER_HOUR, SEATS } from "@/lib/app-db";
import { TERMS_VERSION } from "@/lib/terms";
import { appTokenStore } from "@/lib/token-store-app";
import { freshAppDb, seedUser } from "./harness";

const NOW = Date.now();
const HOUR = 3_600_000;
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number> = {}) => (await db.raw().execute({ sql, args })).rows;
const ask = (email: string, o: { name?: string; agreed?: boolean; now?: number } = {}) =>
  createJoinRequest({ email, name: o.name ?? "", agreed: o.agreed ?? true, now: o.now ?? NOW });

beforeEach(async () => {
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "invite");
  await appTokenStore().get("aaaaaaaaaaaa" as never);
  await seedUser(db.raw(), { uid: "aaaaaaaaaaaa", status: "active", admin: true });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the request form's storage", () => {
  it("stores the e-mail (trimmed, lower case), the name or a filler, the terms accepted, as pending", async () => {
    const a = await ask("  Friend.One@Example.COM ", { name: "  Sam  " });
    const b = await ask("two@example.com");
    expect(a.ok && b.ok).toBe(true);
    const rows = await q("SELECT id, email, name, status, created_at, terms_version, uid FROM requests ORDER BY email");
    expect(rows.map((r) => [r.email, r.name, r.status, r.terms_version, r.uid])).toEqual([
      ["friend.one@example.com", "Sam", "pending", TERMS_VERSION, null],
      ["two@example.com", "A friend", "pending", TERMS_VERSION, null],
    ]);
    expect(rows.every((r) => /^[a-z2-7]{12}$/.test(String(r.id)) && r.created_at === NOW)).toBe(true);
  });

  it("is shut under SIGNUPS=owner (or unset), so nothing is stored before the door opens", async () => {
    for (const mode of ["", "owner"]) {
      vi.stubEnv("SIGNUPS", mode);
      expect(await ask("x@example.com")).toEqual({ ok: false, reason: "closed" });
    }
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: 0 }]);
  });

  it("refuses without the terms accepted, a malformed e-mail, or an over-long field", async () => {
    expect(await ask("x@example.com", { agreed: false })).toEqual({ ok: false, reason: "terms" });
    for (const bad of ["", "nope", "a@b", "a b@c.d", `${"x".repeat(250)}@example.com`]) {
      expect(await ask(bad), bad).toEqual({ ok: false, reason: "email" });
    }
    expect(await ask("x@example.com", { name: "n".repeat(81) })).toEqual({ ok: false, reason: "name" });
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: 0 }]);
  });

  it("a second request for an open address stores nothing and hands back no request", async () => {
    expect((await ask("x@example.com")).ok).toBe(true);
    expect(await ask("X@example.com")).toEqual({ ok: false, reason: "duplicate" });
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: 1 }]);
  });

  it(`takes at most ${JOIN_PER_HOUR} requests an hour app-wide`, async () => {
    for (let i = 0; i < JOIN_PER_HOUR; i++) expect((await ask(`p${i}@example.com`, { now: NOW + i })).ok).toBe(true);
    expect(await ask("late@example.com", { now: NOW + 100 })).toEqual({ ok: false, reason: "busy" });
    expect((await ask("late@example.com", { now: NOW + HOUR + 1 })).ok).toBe(true);
  });

  it(`holds at most ${JOIN_PENDING_CAP} open requests, whatever the hour`, async () => {
    for (let i = 0; i < JOIN_PENDING_CAP; i++) {
      expect((await ask(`p${i}@example.com`, { now: NOW + i * HOUR })).ok, String(i)).toBe(true);
    }
    expect(await ask("one-more@example.com", { now: NOW + 99 * HOUR })).toEqual({ ok: false, reason: "full" });
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: JOIN_PENDING_CAP }]);
  });

  it(`closes once ${SEATS} people hold places (Rem and four friends, Spotify's User Management cap)`, async () => {
    for (const [i, status] of ["active", "invited", "needs_reconnect", "disabled"].entries()) {
      await seedUser(db.raw(), { uid: `${"bcde"[i]}`.repeat(12), status });
    }
    expect(await ask("x@example.com")).toEqual({ ok: false, reason: "full" });
    await q("UPDATE users SET status = 'deleted' WHERE uid = 'bbbbbbbbbbbb'");
    expect((await ask("x@example.com")).ok).toBe(true);
  });

  it("never calls out of the app database: no fetch, so no database is created", async () => {
    const spy = vi.fn(async () => new Response("no"));
    vi.stubGlobal("fetch", spy);
    expect((await ask("x@example.com")).ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
