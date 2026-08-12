"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
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

// App chrome: ONE top bar, both sizes (the mobile bottom tab bar is gone — two bars ate
// too much of a phone screen; Rem, 2026-08-12). Desktop: mark, quiet nav, now-playing,
// avatar. Phone: the same bar at 75% scale, with the Home text link dropped — the panda
// mark IS home there — and the bar slides away as you scroll down (direction-tracked,
// back the moment you scroll up), because the header is the least useful thing on screen
// mid-list.

const TABS = [
  { key: "home", href: "/home", label: "Home" },
  { key: "playlists", href: "/playlists", label: "Playlists" },
  { key: "friends", href: "/friends", label: "Friends" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

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
  // useActiveTab() FALLS BACK to "home" for routes that aren't tabs (/usage), which is right
  // for the highlight but wrong for the arrow-key handler — on those routes the arrows belong
  // to the page (the ledger's day pager), so the tab switcher must stand down entirely.
  const onTabRoute = TABS.some((t) => pathname.startsWith(t.href));
  const { playing } = useNowPlaying();
  const awake = !!playing?.isPlaying;
  const router = useRouter();
  const tabRefs = useRef<Partial<Record<TabKey, HTMLAnchorElement>>>({});
  // ←/→ move between the top tabs. Neighboring routes are prefetched so the switch is
  // instant. Ignored while typing (search field) or with a dialog/sheet open, and when a
  // modifier is held (browser shortcuts), so it only fires on a bare arrow press.
  useEffect(() => {
    TABS.forEach((t) => router.prefetch(t.href));
    const idx = TABS.findIndex((t) => t.key === active);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (!onTabRoute) return;
      const next = e.key === "ArrowRight" ? idx + 1 : idx - 1;
      if (next < 0 || next >= TABS.length) return;
      e.preventDefault();
      router.push(TABS[next].href);
      // Move DOM focus with the selection. Without this, the tab you clicked keeps
      // browser focus after the route changes — and since the keydown itself is what
      // upgrades the browser's :focus-visible heuristic, its ring reappears on the
      // now-inactive old tab instead of the one arrow keys just navigated to.
      tabRefs.current[TABS[next].key]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onTabRoute, router]);

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
            a slow breathe while nothing plays, the slight sway while something does.
            On the phone this IS the Home control (the nav below drops its Home link). */}
        <Link href="/home" className="flex items-center" aria-label="Lazy Boy">
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
              className={cn(
                // No focus ring on the tabs: arrow-key nav moves DOM focus with the
                // selection, and the ring hopping tab to tab reads as a stray box.
                // Active state is already carried by the text weight/colour.
                "rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors outline-none focus-visible:outline-none sm:px-3 sm:text-[15px]",
                t.key === "home" && "hidden sm:block", // the panda is Home on the phone
                t.key === active
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
const RING_CACHE = "lb-ring:";

// The account control from the live header, carried over: pfp with a ring tinted to
// its average colour, enlarging on hover, opening a menu with log out.
//
// The tint is derived from the image through a canvas, which takes a beat. The header is
// rendered per-page, so it REMOUNTS on every navigation — meaning the ring used to reset to
// the grey fallback and then animate back to the tint each time you changed pages. That was
// the flash. The colour is memoised per image URL and re-applied in a layout effect (before
// paint), so a remount starts already-correct and there is nothing left to animate.
function AccountMenu({ name, image }: { name: string; image: string | null }) {
  const [ringColor, setRingColor] = useState(RING_FALLBACK);
  const [hover, setHover] = useState(false);

  // Before paint: if we've already computed this image's tint, use it immediately. Runs on the
  // client only (useLayoutEffect is a no-op on the server, hence the guard).
  const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
  useIsoLayoutEffect(() => {
    if (!image) return;
    try {
      const cached = sessionStorage.getItem(RING_CACHE + image);
      if (cached) setRingColor(cached);
    } catch {
      /* storage unavailable — fall through and compute */
    }
  }, [image]);

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
            sessionStorage.setItem(RING_CACHE + image, c);
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
  }, [image]);

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
          <form action={logout}>
            <DropdownMenuItem
              nativeButton
              render={<button type="submit" />}
              className="w-full cursor-pointer gap-2 px-1.5 py-1.5 text-foreground"
            >
              <LogOut className="size-4" />
              Log out
            </DropdownMenuItem>
          </form>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}


