// /join, its POST and the join link (RULINGS Oct 15 12:46 PM; FASTPATH.md §5): the form stores a
// request and leaves a signed request cookie for that request only; the link Rem sends sets the
// same cookie while its invite is open; a failure sets nothing. The page shows a cookie's holder
// where their request stands and nothing about anyone else's.
import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinTokenHash, REQUEST_COOKIE, verifyRequestCookie } from "@/lib/request-cookie";
import { appTokenStore } from "@/lib/token-store-app";
import { freshAppDb, seedApprovedInvite, seedUser } from "./harness";

vi.mock("@/app/(app)/actions", () => ({ login: async () => {} }));
vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());

const NOW = Date.now();
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number> = {}) => (await db.raw().execute({ sql, args })).rows;

beforeEach(async () => {
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "invite");
  vi.stubEnv("AUTH_SECRET", "test-auth-secret-0123456789");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await appTokenStore().get("aaaaaaaaaaaa" as never);
  await seedUser(db.raw(), { uid: "aaaaaaaaaaaa", status: "active", admin: true });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const post = async (body: string, url = "https://lazy.example/api/join") => {
  const { POST } = await import("@/app/api/join/route");
  return POST(new Request(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }));
};
const cookieOf = (r: Response) => {
  const c = r.headers.get("set-cookie");
  return c ? c.split(";")[0].slice(REQUEST_COOKIE.length + 1) : null;
};

describe("POST /api/join", () => {
  it("stores the request and leaves a signed, HttpOnly, Lax, Secure cookie naming it", async () => {
    const r = await post("email=x%40example.com&name=&agree=on");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/join");
    const header = r.headers.get("set-cookie")!;
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Secure/);
    const rid = verifyRequestCookie(cookieOf(r), NOW + 1000);
    expect((await q("SELECT id, email FROM requests"))[0]).toEqual({ id: rid, email: "x@example.com" });
  });

  it("a refusal sets no cookie and says why", async () => {
    const no = await post("email=x%40example.com");
    expect(no.headers.get("location")).toBe("/join?error=terms");
    expect(no.headers.get("set-cookie")).toBeNull();
    vi.stubEnv("SIGNUPS", "owner");
    const shut = await post("email=y%40example.com&agree=on");
    expect(shut.headers.get("location")).toBe("/join?error=closed");
    expect(shut.headers.get("set-cookie")).toBeNull();
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: 0 }]);
  });

  it("refuses a body over 4 KB before parsing it", async () => {
    const r = await post(`email=x%40example.com&agree=on&name=${"n".repeat(5000)}`);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await q("SELECT count(*) AS n FROM requests")).toEqual([{ n: 0 }]);
  });
});

describe("GET /api/join/link", () => {
  const link = async (t: string) => {
    const { GET } = await import("@/app/api/join/link/route");
    return GET(new Request(`https://lazy.example/api/join/link?t=${t}`));
  };

  it("sets the request cookie for the approved request whose token it carries, while the invite is open", async () => {
    await post("email=x%40example.com&agree=on");
    const [{ id }] = await q("SELECT id FROM requests");
    await seedApprovedInvite(db.raw(), { rid: String(id), uid: "xxxxxxxxxxxx", invitedAt: NOW - 1000 });
    const token = randomBytes(32).toString("base64url");
    await q("UPDATE requests SET join_hash = :h", { h: joinTokenHash(token) });
    const r = await link(token);
    expect(r.headers.get("location")).toBe("/join");
    expect(verifyRequestCookie(cookieOf(r), NOW + 1000)).toBe(id);

    // A wrong token, a claimed invite, an expired invite: no cookie.
    expect((await link(randomBytes(32).toString("base64url"))).headers.get("set-cookie")).toBeNull();
    expect((await link("short")).headers.get("set-cookie")).toBeNull();
    await q("UPDATE users SET invited_at = :t WHERE uid = 'xxxxxxxxxxxx'", { t: NOW - 15 * 86_400_000 });
    expect((await link(token)).headers.get("set-cookie")).toBeNull();
    await q("UPDATE users SET invited_at = :t, status = 'active', account_id = 'acct-x' WHERE uid = 'xxxxxxxxxxxx'", { t: NOW });
    expect((await link(token)).headers.get("location")).toBe("/join?error=link");
  });
});

describe("/join", () => {
  const view = async (state: "pending" | "approved" | "claimed" | null, error?: string) => {
    const { JoinView } = await import("@/app/(auth)/join/join-view");
    return renderToStaticMarkup(createElement(JoinView, { state, error })).replace(/<[^>]+>/g, " ");
  };
  it("without a request: what a friend gets, the form, and the policy and terms to accept", async () => {
    const { JoinView } = await import("@/app/(auth)/join/join-view");
    const html = renderToStaticMarkup(createElement(JoinView, { state: null }));
    for (const s of ["Spotify Premium", "last 50 plays", "Disconnect deletes everything within five days", "not backed up", "Five people in all", "can technically read it"]) {
      expect(html).toContain(s);
    }
    const form = html.match(/<form[^>]*action="\/api\/join"[^>]*>/)?.[0] ?? "";
    expect(form).toMatch(/method="post"/i);
    expect(html).toMatch(/<input type="email" required=""[^>]*name="email"/);
    expect(html).toMatch(/<input type="checkbox" required=""[^>]*name="agree"/);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
  });
  it("with a request: only where it stands", async () => {
    expect(await view("pending")).toContain("Your request is in");
    expect(await view("approved")).toContain("Connect Spotify");
    expect(await view("approved")).not.toContain("Ask to join");
    expect(await view("claimed")).toContain("Sign in");
    expect(await view(null, "full")).toContain("five people");
  });
  it("beside the form, how many of the five places are taken; nothing when the count is unknown or there is no form", async () => {
    const { JoinView } = await import("@/app/(auth)/join/join-view");
    const html = (p: Record<string, unknown>) =>
      renderToStaticMarkup(createElement(JoinView, { state: null, ...p } as never)).replace(/<[^>]+>/g, "");
    expect(html({ held: 1 })).toContain("1 of 5 spots taken");
    expect(html({ held: 4 })).toContain("4 of 5 spots taken");
    expect(html({})).not.toContain("spots taken");
    expect(html({ held: null })).not.toContain("spots taken");
    expect(html({ held: 1, closed: true })).not.toContain("spots taken");
    expect(html({ held: 1, state: "pending" })).not.toContain("spots taken");
  });
  it("the page counts the places only while the door is open", async () => {
    const page = async () => renderToStaticMarkup(await (await import("@/app/(auth)/join/page")).default({ searchParams: Promise.resolve({}) }));
    await seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "active" });
    expect(await page()).toContain("2 of 5 spots taken");
    vi.stubEnv("SIGNUPS", "owner");
    expect(await page()).not.toContain("spots taken");
  });
  it("under SIGNUPS=owner it offers no form, only the closed notice", async () => {
    const { JoinView } = await import("@/app/(auth)/join/join-view");
    const html = renderToStaticMarkup(createElement(JoinView, { state: null, closed: true }));
    expect(html).toContain("isn&#x27;t taking requests");
    expect(html).not.toContain('action="/api/join"');
  });
});
