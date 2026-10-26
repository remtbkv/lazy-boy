"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Unplug } from "lucide-react";
import { logout } from "./actions";
import { NowPlaying } from "@/components/now-playing";
import { useNowPlaying } from "@/components/now-playing-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { announceTabReset } from "@/lib/tab-reset";
import { choose, commit, IDLE, press, tabOf, type TabNav } from "@/lib/tab-nav";
import { clearStored, idbKV } from "@/lib/search-cache";
import { clearThisBrowser, userStorageName } from "@/lib/user-storage";
import { useUid } from "@/components/user-context";

// App chrome: ONE top bar, both sizes (the mobile bottom tab bar is gone — two bars ate
// too much of a phone screen; Rem, 2026-08-12). Mark, quiet nav (Home / Playlists /
// Friends on every width), now-playing, avatar. On the phone the bar slides away as you
// scroll down (direction-tracked, back the moment you scroll up), because the header is
// the least useful thing on screen mid-list.

const TABS = [
  { key: "home", href: "/home", label: "Home" },
  { key: "playlists", href: "/playlists", label: "Playlists" },
  { key: "friends", href: "/friends", label: "Friends" },
] as const;
const TAB_HREFS = TABS.map((t) => t.href);

type TabKey = (typeof TABS)[number]["key"];

// How long a page the person has left stays inert while their choice loads. A navigation that
// never commits must not leave the page dead.
const LEAVE_MAX_MS = 8000;

// `active` and `awake` are derived here rather than passed in, because the chrome now lives in
// the layout and must not depend on which page rendered it. `awake` comes straight from the
// now-playing state (something is playing ⇒ awake), which also removed a DB query from the
// page load — it used to be answered by fetching the most recent play.
function useActiveTab(): TabKey {
  const pathname = usePathname();
  if (pathname.startsWith("/playlists")) return "playlists";
  if (pathname.startsWith("/friends")) return "friends";
  return "home";
}

export function DenChrome({ name, image }: { name: string; image: string | null }) {
  const active = useActiveTab();
  const pathname = usePathname();
  const { playing } = useNowPlaying();
  const awake = !!playing?.isPlaying;
  const router = useRouter();
  const tabRefs = useRef<Partial<Record<TabKey, HTMLAnchorElement>>>({});
  // The place the person last chose and the places they left (lib/tab-nav.ts). The handlers read
  // the ref at the moment of a press; `target` re-renders the highlight and the inert page.
  const nav = useRef<TabNav>(IDLE);
  const [target, setTarget] = useState<string | null>(null);
  const apply = useCallback((s: TabNav) => {
    nav.current = s;
    setTarget(s.target);
  }, []);
  // The highlight follows the choice at once; the page follows when its navigation commits.
  const targetTab = target === null ? -1 : tabOf(TAB_HREFS, target);
  const shown: TabKey = targetTab >= 0 ? TABS[targetTab].key : active;
  // The page on screen is one the person has left: their choice is still on its way.
  const isLeaving = target !== null && target !== pathname;

  useEffect(() => {
    TABS.forEach((t) => router.prefetch(t.href));
  }, [active, router]);

  // ←/→ move between the top tabs. Neighboring routes are prefetched so the switch is
  // instant. Ignored while typing (search field) or with a dialog/sheet open, and when a
  // modifier is held (browser shortcuts), so it only fires on a bare arrow press.
  //
  // Each press moves from the tab the LAST press chose, never the committed route: a press while
  // a navigation is still loading used to repeat it or be dropped, and the stale one landed later
  // (lib/tab-nav.ts). The route on screen is read at the press, from the address bar Next writes
  // at commit, so there is no window between a commit and an effect re-running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      // Off the tabs (/usage) the arrows belong to the page (the ledger's day pager).
      const at = window.location.pathname;
      if (tabOf(TAB_HREFS, at) < 0) return;
      const { state, go } = press(nav.current, TAB_HREFS, at, e.key === "ArrowRight" ? 1 : -1);
      if (go === null) return;
      e.preventDefault();
      apply(state);
      // Back to the page on screen: navigating to it is what stops the one still loading. It
      // stays where it was scrolled.
      if (go === at) router.replace(at + window.location.search, { scroll: false });
      else router.push(go);
      // Move DOM focus with the selection. Without this, the tab you clicked keeps
      // browser focus after the route changes — and since the keydown itself is what
      // upgrades the browser's :focus-visible heuristic, its ring reappears on the
      // now-inactive old tab instead of the one arrow keys just navigated to. It also keeps
      // Enter on the tab the person chose.
      tabRefs.current[TABS[tabOf(TAB_HREFS, go)].key]?.focus();
    };
    // A link to a tab's page (a tab, the mark, a playlist card) or Back/Forward is a choice too;
    // any other link ends the bookkeeping (a download or a page off the tabs never commits here).
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target || a.hasAttribute("download")) return;
      const url = new URL(a.href);
      if (url.origin !== window.location.origin) return;
      apply(tabOf(TAB_HREFS, url.pathname) >= 0 ? choose(nav.current, url.pathname) : IDLE);
    };
    const onPop = () => {
      const at = window.location.pathname;
      apply(tabOf(TAB_HREFS, at) >= 0 ? choose(nav.current, at) : IDLE);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, [apply, router]);

  // A commit of a place the person already left — a slow push that lost the race, or the state
  // Next 16.2 kept from one and rendered on the next server action — sends them back to their
  // choice. Replace, so the stray page leaves no history entry.
  useEffect(() => {
    const { state, go } = commit(nav.current, pathname);
    if (state !== nav.current) apply(state);
    if (go !== null) router.replace(go, { scroll: false });
  }, [pathname, apply, router]);

  // The page the person has left takes no clicks, keys or focus while their choice loads
  // (layout.tsx's data-lb-page wrapper), so nothing acts on it: not the search they reach for,
  // not an Enter. Bounded, so a navigation that never commits cannot leave it dead.
  useEffect(() => {
    if (!isLeaving) return;
    const page = document.querySelector("[data-lb-page]");
    if (!page) return;
    page.setAttribute("inert", "");
    const t = setTimeout(() => page.removeAttribute("inert"), LEAVE_MAX_MS);
    return () => {
      clearTimeout(t);
      page.removeAttribute("inert");
    };
  }, [isLeaving, target]);

  // Phone: the bar slides up as you scroll down and back the moment you scroll up —
  // DIRECTION-tracked (an accumulator over scroll deltas), not distance-from-top, so it
  // returns anywhere in the page, not only near the top. Desktop never hides: Home is
  // viewport-locked there (scrollY stays 0) and the header isn't crowding anything.
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    let last = window.scrollY;
    let p = 0; // 0 = shown, 1 = fully off-screen
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (window.innerWidth >= 640) {
        el.style.transform = "";
        p = 0;
        return;
      }
      const y = Math.max(0, window.scrollY);
      p = Math.min(1, Math.max(0, p + (y - last) / 120));
      last = y;
      if (y <= 8) p = 0; // at the very top the bar is always home
      el.style.transform = `translate3d(0, ${(-p * 100).toFixed(1)}%, 0)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    // Translucent + blurred: on a scrolling page (Playlists) the artwork passes UNDER the header
    // rather than hitting an opaque wall, so it reads as one continuous surface.
    <header
      ref={headerRef}
      className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl"
    >
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-4 px-4 sm:gap-6 sm:px-6">
        {/* Just the mark — the tab title already says the name. Gentle idle motion:
            a slow breathe while nothing plays, the slight sway while something does. */}
        <Link
          href="/home"
          className="flex items-center"
          aria-label="Lazy Boy"
          // The mark is a Home link too, so it clears Home's search for the same reason the
          // Home tab does — leaving one of the two inert would just be the same complaint
          // again.
          onClick={() => {
            if (pathname === "/home") announceTabReset("home");
          }}
        >
          <img
            src="/icon.svg"
            alt=""
            className={"size-9 " + (awake ? "den-panda-awake" : "den-panda-asleep")}
          />
        </Link>

        {/* Nav — quiet text, active = full-strength foreground, no boxes. prefetch(true)
            pulls the FULL route (a dynamic route's default prefetch stops at its loading
            boundary), so a tab tap paints from cache instead of waiting out a server
            render — the Friends page is constant text and still took a round trip. */}
        <nav className="flex items-center gap-0.5 sm:gap-1">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              prefetch={true}
              ref={(el) => {
                tabRefs.current[t.key] = el ?? undefined;
              }}
              // Pressing the tab you are already on is a navigation to nowhere, so the page
              // keeps whatever was in its search box. Tell it to clear (tab-reset.ts) — Rem,
              // 2026-08-22.
              onClick={() => {
                if (pathname === t.href) announceTabReset(t.key);
              }}
              className={cn(
                // No focus ring on the tabs: arrow-key nav moves DOM focus with the
                // selection, and the ring hopping tab to tab reads as a stray box.
                // Active state is already carried by the text weight/colour.
                // Full 15px on the phone too (Rem, 2026-08-13): the single bar has the
                // room, and 13px read as desktop-shrunk. Home is a real tab everywhere —
                // panda-as-home was too implicit.
                "rounded-md px-2.5 py-1.5 text-[15px] font-medium transition-colors outline-none focus-visible:outline-none sm:px-3",
                t.key === shown
                  ? "text-foreground"
                  : "text-muted-foreground/70 hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 sm:gap-4">
          {/* Current song, same chip as the live header. Wrapped in `den-np` so the
              title/artist box is pinned to a fixed width (den.css) — otherwise it
              measures each song and animates its width, shifting everything right of it.
              The provider is in the layout, so this does NOT remount on navigation. */}
          <div className="den-np">
            <NowPlaying />
          </div>
          <AccountMenu name={name} image={image} />
        </div>
      </div>
    </header>
  );
}

const RING_FALLBACK = "rgb(150, 150, 158)";

// The account control from the live header, carried over: pfp with a ring tinted to
// its average colour, enlarging on hover, opening a menu with log out.
//
// The tint is derived from the image through a canvas, which takes a beat. The header is
// rendered per-page, so it REMOUNTS on every navigation — meaning the ring used to reset to
// the grey fallback and then animate back to the tint each time you changed pages. That was
// the flash. The colour is memoised per image URL and re-applied in a layout effect (before
// paint), so a remount starts already-correct and there is nothing left to animate.
function AccountMenu({ name, image }: { name: string; image: string | null }) {
  // The ring cache is per user (userStorageName(uid, "lb-ring:") + the image URL): an image URL
  // is a person's profile picture.
  const uid = useUid();
  const [ringColor, setRingColor] = useState(RING_FALLBACK);
  const [hover, setHover] = useState(false);

  // Before paint: if we've already computed this image's tint, use it immediately. Runs on the
  // client only (useLayoutEffect is a no-op on the server, hence the guard).
  const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
  useIsoLayoutEffect(() => {
    if (!image) return;
    try {
      const cached = sessionStorage.getItem(userStorageName(uid, "lb-ring:") + image);
      if (cached) setRingColor(cached);
    } catch {
      /* storage unavailable — fall through and compute */
    }
  }, [image, uid]);

  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const s = 16;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = s;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, s, s);
        const { data } = ctx.getImageData(0, 0, s, s);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 16) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
        if (n && !cancelled) {
          const c = `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
          setRingColor(c);
          try {
            sessionStorage.setItem(userStorageName(uid, "lb-ring:") + image, c);
          } catch {
            /* quota / unavailable — recomputing next time is harmless */
          }
        }
      } catch {
        /* tainted canvas (no CORS) → keep the gray fallback */
      }
    };
    img.src = image;
    return () => {
      cancelled = true;
    };
  }, [image, uid]);

  // Hover-open with a short close delay to bridge trigger → menu (Base UI's Menu has
  // no openOnHover) — same mechanism as the live header.
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setMenuOpen(true), 180);
  };
  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setMenuOpen(false), 150);
  };
  useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return (
    <div onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(o) => {
          if (!o && openTimer.current) clearTimeout(openTimer.current);
          setMenuOpen(o);
        }}
      >
        <DropdownMenuTrigger
          aria-label="Account"
          render={
            <Button
              variant="ghost"
              className="relative flex size-8 items-center justify-center rounded-full p-0 hover:bg-transparent focus-visible:border-transparent focus-visible:ring-0"
            />
          }
        >
          <span
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            className="inline-flex rounded-full transition-all duration-150"
            style={{
              transform: hover ? "scale(1.1)" : "scale(1)",
              boxShadow: hover
                ? `0 0 0 3px ${ringColor}, 0 0 6px 1px ${ringColor.replace("rgb(", "rgba(").replace(")", ", 0.45)")}`
                : `0 0 0 2px ${ringColor}`,
            }}
          >
            <Avatar className="size-8">
              {image ? <AvatarImage src={image} alt="" className="object-cover" /> : null}
              <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-60 rounded-xl p-1.5"
          onMouseEnter={openMenu}
          onMouseLeave={scheduleClose}
        >
          <div className="px-1.5 py-1.5">
            <p className="truncate text-sm font-medium text-foreground">{name}</p>
          </div>
          <DropdownMenuSeparator className="bg-border/60" />
          {/* Sign-out clears this browser's copy of the user's data before the action runs: the
              action's response cannot carry Clear-Site-Data (multi-user PLAN §6.2 layer 6). The
              browser's copy of the search payloads (search-cache.ts) goes with it. */}
          <form
            action={logout}
            onSubmit={() => {
              clearThisBrowser(uid);
              void clearStored(idbKV(uid));
            }}
          >
            <DropdownMenuItem
              nativeButton
              render={<button type="submit" />}
              className="w-full cursor-pointer gap-2 px-1.5 py-1.5 text-foreground"
            >
              <LogOut className="size-4" />
              Log out
            </DropdownMenuItem>
          </form>
          {/* Disconnect (RULINGS Oct 15 1:17 PM): its page offers the export first, then asks for
              the typed word and a fresh sign-in; for Rem it says his account is never deleted. */}
          <DropdownMenuItem
            render={<Link href="/disconnect" />}
            className="w-full cursor-pointer gap-2 px-1.5 py-1.5 text-muted-foreground"
          >
            <Unplug className="size-4" />
            Disconnect…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}


