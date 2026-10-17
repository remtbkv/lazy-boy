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
    // Phase 4a: true of what the multi-user build stores and does (CLAUDE.md: change what the app
    // stores, change /privacy).
    const p = privacy.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'");
    for (const s of [
      "the e-mail address on your Spotify account and the name you give",
      "stored encrypted",
      "Your data is not backed up",
      "one day of point-in-time history",
      "your encrypted tokens included",
      "he can technically read your data",
      "It works only with Rem's own data and never reads yours.",
      "Log out signs you out on every browser and stops recording your listening",
      "deletes your data on the fourth day",
      // Lane 09's review: §5.4 steps 3-4 keep the data when the failure may be Spotify's (several
      // people at once) or a lapsed six-month grant, so the page must not promise the deletion.
      "it keeps your data until you sign in again or ask Rem to delete it",
      // The deleted row keeps account_id for five days (deletion.ts markDeleted), so say so.
      "keeps only your Spotify account ID with a note that the account was deleted",
      "spotify.com/account/apps",
      // Phase 4a's turn: the backup job keeps only Rem's rows (ops/zenbook-backup, RULINGS Oct 15
      // 6:21 PM); /usage shows a friend's diagnostics only in totals by page; the host's Data
      // Cache holds copies under the uid that the deletion job does not reach.
      "those copies hold none of yours, diagnostic logs included",
      "only as totals by page",
      "cached copies of some of what your pages show",
      // Lane 20's review: what the browser files besides timings (error.tsx's js-error rows, the
      // handoff beacon's track id) and the server's own error rows, which carry no uid and the
      // route's template, not the raw path (instrumentation.ts).
      // Main's line (np/followups 9b6192f) says the same in its own words: the browser's error
      // messages, and the handoff record's song IDs (handoffBeaconMeta: `id=`, `pred=`).
      "and error messages), with a random ID for the browser tab",
      "the Spotify IDs of that song and the one before it",
      "Errors the server runs into are logged by page and message, with no account's ID.",
      // Lane 21: the daily chores expire a departed user's Data Cache entries by their uid's tag
      // for the five days the deleted row is kept (daily-4a.ts, user-cache.ts expireUserCache).
      "Lazy Boy tells Vercel to purge every copy labelled with your ID",
    ]) {
      expect(p, s).toContain(s);
    }
    expect(p).not.toContain("14 days and in"); // the single-user backup sentence is gone

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
    // cpu_meter (db.ts meterFlush via budget/request-meter.ts): one row per day, route and uid
    // with its invocations, CPU, wall time and bytes; nothing prunes it, so no 30-day claim.
    expect(t).toContain("how many requests each page and address of the app served for you, the server time they took and how much data they sent");
    expect(t).toContain("kept for as long as you stay connected");
  });

  it("names what the library copy and the history carry", async () => {
    const t = await text();
    expect(t).toContain("when each was added"); // playlist_tracks.added_at, saved_tracks.added_at
    expect(t).toContain("whether each play was a skip"); // plays.skipped
  });

  it("names the browser's IndexedDB copy and the tokens' absence from backups", async () => {
    const t = await text();
    expect(t).toContain("IndexedDB"); // search-cache.ts
    // Phase 4a: the nightly copies keep only Rem's rows (ops/zenbook-backup/backup.py, RULINGS Oct
    // 15 6:21 PM), so a friend's tokens are in none of them.
    expect(t).toContain("those copies hold none of yours");
  });

  it("names Phase 2's accounts database, the account ID and the encrypted tokens", async () => {
    const t = await text();
    expect(t).toContain("your Spotify user ID and account ID"); // users.account_id (identity-read.ts resolveSignIn)
    expect(t).toContain("stored encrypted"); // user_tokens.blob (token-crypto.ts, AES-256-GCM)
    expect(t).toContain("accounts database (who has an account, your request, and your encrypted sign-in tokens) is on Turso too"); // app-db.ts users, requests, user_tokens
    expect(t).not.toContain("timezone and sign-in tokens are in a database"); // the tokens left `lazyboy` for user_tokens
  });

  it("names Phase 3's timezone name beside its offset", async () => {
    const t = await text();
    expect(t).toContain("your timezone (its name and offset)"); // db.ts user_tz and user_tz_offset (api/sync)
    expect(t).toContain("two cookies holding your timezone"); // timezone-cookie.tsx: tzoffset and tzname
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
