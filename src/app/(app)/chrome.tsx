"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Disc3, Home, LibraryBig, LogOut } from "lucide-react";
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

// App chrome. Desktop: one slim top bar — mark, wordmark, quiet nav, skin toggle,
// account avatar. Mobile: the top bar shrinks to mark + wordmark, and navigation moves
// to a bottom tab bar (thumb reach), padded past the iOS home indicator. Solid
// backgrounds throughout — no translucency, no blur.
//

const TABS = [
  { key: "home", href: "/home", label: "Home", icon: Home },
  { key: "playlists", href: "/playlists", label: "Playlists", icon: LibraryBig },
  { key: "friends", href: "/friends", label: "Friends", icon: Disc3 },
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
  }, [active, router]);

  return (
    // Translucent + blurred: on a scrolling page (Playlists) the artwork passes UNDER the header
    // rather than hitting an opaque wall, so it reads as one continuous surface.
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-6 px-4 sm:px-6">
        {/* Just the mark — the tab title already says the name. Gentle idle motion:
            a slow breathe while nothing plays, the slight sway while something does. */}
        <Link href="/home" className="flex items-center" aria-label="Lazy Boy">
          <img
            src="/icon.svg"
            alt=""
            className={"size-9 " + (awake ? "den-panda-awake" : "den-panda-asleep")}
          />
        </Link>

        {/* Desktop nav — quiet text, active = full-strength foreground, no boxes. */}
        <nav className="hidden items-center gap-1 sm:flex">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              ref={(el) => {
                tabRefs.current[t.key] = el ?? undefined;
              }}
              className={cn(
                // No focus ring on the tabs: arrow-key nav moves DOM focus with the
                // selection, and the ring hopping tab to tab reads as a stray box.
                // Active state is already carried by the text weight/colour.
                "rounded-md px-3 py-1.5 text-[15px] font-medium transition-colors outline-none focus-visible:outline-none",
                t.key === active
                  ? "text-foreground"
                  : "text-muted-foreground/70 hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          {/* Current song, same chip as the live header. Wrapped in `den-np` so the
              title/artist box is pinned to a fixed width (den.css) — otherwise it
              measures each song and animates its width, shifting everything right of it.
              The provider is in the layout, so this does NOT remount on navigation. */}
          <div className="den-np">
            <NowPlaying />
          </div>
          <div className="hidden sm:block">
            <AccountMenu name={name} image={image} />
          </div>
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

export function DenBottomNav({ name, image }: { name: string; image: string | null }) {
  const active = useActiveTab();
  // Account tab: first tap reveals a small Log out panel above the bar (never a
  // one-tap sign-out — too easy to hit by accident); tapping elsewhere dismisses it.
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-background pb-[env(safe-area-inset-bottom)] sm:hidden"
      aria-label="Primary"
    >
      {accountOpen ? (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setAccountOpen(false)}
            className="fixed inset-0 -z-10"
          />
          <div className="absolute bottom-full right-3 mb-2 w-52 rounded-xl border border-border bg-popover p-1.5 shadow-xl shadow-black/40">
            <p className="truncate px-2 py-1.5 text-sm font-medium">{name}</p>
            <div className="my-1 h-px bg-border/60" />
            <form action={logout}>
              <button
                type="submit"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground active:bg-accent"
              >
                <LogOut className="size-4" />
                Log out
              </button>
            </form>
          </div>
        </>
      ) : null}
      <div className="mx-auto flex h-16 max-w-md items-stretch">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = t.key === active;
          return (
            <Link
              key={t.key}
              href={t.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                on ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              <Icon className="size-[22px]" strokeWidth={on ? 2.2 : 1.8} />
              {t.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setAccountOpen((o) => !o)}
          aria-expanded={accountOpen}
          className="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground/70"
        >
          <Avatar className="size-6">
            {image ? <AvatarImage src={image} alt="" className="object-cover" /> : null}
            <AvatarFallback className="text-[10px]">{name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          {name.split(" ")[0] || "You"}
        </button>
      </div>
    </nav>
  );
}

