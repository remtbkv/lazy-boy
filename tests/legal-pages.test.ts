// Spotify's Developer Terms (Section V) require a privacy policy shown before sign-up and an
// end-user agreement the user must agree to. /privacy and /terms must be readable by someone
// who has never signed in, and /login must say, before the button is pressed, that connecting
// is agreeing to both.
import { existsSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/app/(app)/actions", () => ({ login: async () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const APP = path.resolve(__dirname, "../src/app");

beforeEach(() => {
  authMock.mockReset();
});

describe("/privacy and /terms", () => {
  it("live outside the (app) group, whose layout redirects anyone without a session", () => {
    expect(existsSync(path.join(APP, "(legal)/privacy/page.tsx"))).toBe(true);
    expect(existsSync(path.join(APP, "(legal)/terms/page.tsx"))).toBe(true);
    expect(existsSync(path.join(APP, "(app)/privacy"))).toBe(false);
    expect(existsSync(path.join(APP, "(app)/terms"))).toBe(false);
  });

  it("render with no session and never ask for one", async () => {
    authMock.mockImplementation(() => {
      throw new Error("a legal page called auth()");
    });
    const { default: Layout } = await import("@/app/(legal)/layout");
    const { default: Privacy } = await import("@/app/(legal)/privacy/page");
    const { default: Terms } = await import("@/app/(legal)/terms/page");

    const privacy = renderToStaticMarkup(createElement(Layout, null, createElement(Privacy)));
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).toContain("remtbkv@gmail.com");
    expect(privacy).toContain("five days");

    const terms = renderToStaticMarkup(createElement(Layout, null, createElement(Terms)));
    expect(terms).toContain("Terms of Use");
    expect(terms).toContain("third-party beneficiary");
    expect(terms).toContain("non-infringement");
    expect(authMock).not.toHaveBeenCalled();
  });
});

// /privacy has to be true of the code (Developer Terms §V). Each line below names the code path
// the page discloses (review 0158 finding 4: browser errors went unsaid, and the page still had
// the database moving to Turso after it moved on 2026-10-16).
describe("/privacy says what the code stores and logs", () => {
  const text = async () => {
    const { default: Privacy } = await import("@/app/(legal)/privacy/page");
    return renderToStaticMarkup(createElement(Privacy)).replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
  };

  it("names where the data is today", async () => {
    const t = await text();
    expect(t).not.toContain("planned move"); // core is on Turso (db.ts, CLAUDE.md)
    expect(t).toContain("on Turso");
    expect(t).toContain("diagnostic logs are on a computer Rem owns"); // getTelemetryClient: sqld on the Zenbook
  });

  it("names every kind of diagnostic row", async () => {
    const t = await text();
    expect(t).toContain("error messages"); // metrics-client.ts js-error; instrumentation.ts server-error
    expect(t).toContain("how long the page stayed in view"); // visit-ms
    expect(t).toContain("which page of the app you went to next"); // nav-ms
    expect(t).toContain("which part of the app made it"); // api_log.source
    expect(t).toContain("kept 30 days"); // pruneApiLog, pruneClientMetrics
    expect(t).toContain("only that it was private and how long it played"); // handoffBeaconMeta
  });

  it("names what the library copy and the history carry", async () => {
    const t = await text();
    expect(t).toContain("when each was added"); // playlist_tracks.added_at, saved_tracks.added_at
    expect(t).toContain("whether each play was a skip"); // plays.skipped
  });

  it("names the browser's IndexedDB copy and the tokens' absence from backups", async () => {
    const t = await text();
    expect(t).toContain("IndexedDB"); // search-cache.ts
    expect(t).toContain("with the sign-in tokens removed"); // backup.py STRIP
  });
});

describe("/login consent line", () => {
  it("is shown before sign-in, beside the connect button, linking both pages", async () => {
    authMock.mockResolvedValue(null);
    const { default: LoginPage } = await import("@/app/(auth)/login/page");
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    const text = html.replace(/<[^>]+>/g, "");

    expect(text).toContain(
      "By connecting your Spotify account you agree to the Terms and the Privacy Policy",
    );
    expect(html).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
    // Inside the same form as the button, so it sits next to it.
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    expect(form).toContain("Connect Spotify");
    expect(form).toContain('href="/terms"');
  });
});
