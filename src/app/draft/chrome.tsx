"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Disc3, Home, LibraryBig, LogOut } from "lucide-react";
import { logout } from "@/app/(app)/actions";
import { NowPlaying } from "@/components/now-playing";
import { NowPlayingProvider } from "@/components/now-playing-context";
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

// Draft chrome. Desktop: one slim top bar — mark, wordmark, quiet nav, skin toggle,
// account avatar. Mobile: the top bar shrinks to mark + wordmark, and navigation moves
// to a bottom tab bar (thumb reach), padded past the iOS home indicator. Solid
// backgrounds throughout — no translucency, no blur.
//
// Playlists/Friends point at the real pages (the draft covers Home only for now).

const TABS = [
  { key: "home", href: "/draft", label: "Home", icon: Home },
  { key: "playlists", href: "/draft/playlists", label: "Playlists", icon: LibraryBig },
  { key: "friends", href: "/friends", label: "Friends", icon: Disc3 },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function DenChrome({
  awake,
  name,
  image,
  active = "home",
}: {
  awake: boolean;
  name: string;
  image: string | null;
  active?: TabKey;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-5 px-4 sm:px-6">
        {/* Just the mark — the tab title already says the name. Gentle idle motion:
            a slow breathe while nothing plays, the slight sway while something does. */}
        <Link href="/draft" className="flex items-center" aria-label="Lazy Boy">
          <img
            src="/icon.svg"
            alt=""
            className={"size-8 " + (awake ? "den-panda-awake" : "den-panda-asleep")}
          />
        </Link>

        {/* Desktop nav — quiet text, active = full-strength foreground, no boxes. */}
        <nav className="hidden items-center gap-1 sm:flex">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
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
          {/* Current song, same chip as the live header — reports playback here too. */}
          <NowPlayingProvider>
            <NowPlaying />
          </NowPlayingProvider>
          <SkinToggle />
          <div className="hidden sm:block">
            <AccountMenu name={name} image={image} />
          </div>
        </div>
      </div>
    </header>
  );
}

// The account control from the live header, carried over: pfp with a ring tinted to
// its average colour, enlarging on hover, opening a menu with log out.
function AccountMenu({ name, image }: { name: string; image: string | null }) {
  const [ringColor, setRingColor] = useState("rgb(150, 150, 158)");
  const [hover, setHover] = useState(false);
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
          setRingColor(`rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`);
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
                ? `0 0 0 4px ${ringColor}, 0 0 6px 1px ${ringColor.replace("rgb(", "rgba(").replace(")", ", 0.45)")}`
                : `0 0 0 4px ${ringColor}`,
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

export function DenBottomNav({
  name,
  image,
  active = "home",
}: {
  name: string;
  image: string | null;
  active?: TabKey;
}) {
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

// A/B skin switch — the one comparison knob. "den" = warm charcoal + bamboo,
// "ink" = the live app's cool neutrals under the same new layout/type. Label is
// driven purely by CSS off #den-root[data-skin] (see den.css) so hydration can't
// mismatch the pre-paint localStorage skin.
function SkinToggle() {
  const toggle = () => {
    const root = document.getElementById("den-root");
    if (!root) return;
    const next = root.dataset.skin === "ink" ? "den" : "ink";
    root.dataset.skin = next;
    try {
      localStorage.setItem("lb-skin", next);
    } catch {}
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-7 items-center gap-1.5 rounded-md border border-border/80 px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      title="Switch draft palette"
    >
      <span className="den-skin-dot size-2 rounded-full" />
      <span className="den-when-den">den</span>
      <span className="den-when-ink">ink</span>
    </button>
  );
}
