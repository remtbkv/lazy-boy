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
