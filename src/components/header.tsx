"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "@/app/(app)/actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { NowPlaying } from "@/components/now-playing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/home", label: "Home" },
  { href: "/playlists", label: "Playlists" },
  { href: "/history", label: "History" },
  { href: "/friends", label: "Friends" },
];

export function Header({ name, image }: { name: string; image: string | null }) {
  const pathname = usePathname();
  const router = useRouter();

  // Left/right arrows move between the header tabs — except while typing in a
  // field (search pills, inputs), where arrows should move the caret. Reads the
  // live URL (not the closured pathname, which lags a tick) so rapid presses
  // don't skip or no-op.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      const here = window.location.pathname;
      const cur = TABS.findIndex(
        (t) => here === t.href || here.startsWith(t.href + "/"),
      );
      const from = cur === -1 ? 0 : cur;
      const to = e.key === "ArrowRight"
        ? Math.min(TABS.length - 1, from + 1)
        : Math.max(0, from - 1);
      if (to !== from) {
        e.preventDefault();
        router.push(TABS[to].href);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // Tint the avatar ring with the pfp's average colour (falls back to a soft gray
  // if the image can't be sampled, e.g. the CDN doesn't allow cross-origin reads).
  const [ringColor, setRingColor] = useState("rgb(150, 150, 158)");
  const [pfpHover, setPfpHover] = useState(false);
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
          if (data[i + 3] < 16) continue; // skip transparent pixels
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

  // Open the account menu on hover. Base UI's Menu has no openOnHover, so drive
  // it with controlled state + a short close delay to bridge trigger → menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    // Open only after the pfp's enlarge animation (150ms) finishes, so the menu
    // appears as a deliberate second beat rather than racing the scale.
    openTimer.current = setTimeout(() => setMenuOpen(true), 180);
  };
  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setMenuOpen(false), 150);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/home" aria-label="Lazy Boy" className="flex items-center">
          <img src="/icon.svg" alt="Lazy Boy" className="size-8" />
        </Link>

        <nav className="flex items-center gap-0.5 sm:gap-1">
          {TABS.map((tab) => {
            const active =
              pathname === tab.href || pathname.startsWith(tab.href + "/");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  // No focus ring on the tabs — the gray active highlight is the only
                  // indicator, so there's no fast-ring / lagging-highlight mismatch while
                  // a page loads.
                  "rounded-md px-2 py-1.5 text-sm font-semibold outline-none transition-colors focus-visible:outline-none sm:px-3",
                  active
                    ? "bg-secondary text-foreground"
                    : "text-foreground/70 hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        {/* Now-playing chip sits to the left of the avatar with a comfortable gap —
            it reports playback and isn't part of the account control. */}
        <div className="ml-auto flex items-center gap-3 sm:gap-8">
          <NowPlaying />
          <div onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              aria-label="Account"
              render={
                <Button
                  variant="ghost"
                  className="relative flex size-8 items-center justify-center rounded-full p-0 hover:bg-transparent focus-visible:border-transparent focus-visible:ring-0"
                />
              }
            >
              {/* Ring tinted to the pfp's average colour; thickens, glows, and
                  enlarges on hover. (Explicit box-shadow so the dynamic colour and
                  hover state render reliably.) */}
              <span
                onMouseEnter={() => setPfpHover(true)}
                onMouseLeave={() => setPfpHover(false)}
                className="inline-flex rounded-full transition-all duration-150"
                style={{
                  transform: pfpHover ? "scale(1.1)" : "scale(1)",
                  // Constant 4px ring; hover just enlarges and adds a faint
                  // same-colour glow, no thickness change.
                  boxShadow: pfpHover
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
              sideOffset={6}
              className="w-44"
              onMouseEnter={openMenu}
              onMouseLeave={scheduleClose}
            >
              <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <form action={logout}>
                <DropdownMenuItem
                  nativeButton
                  render={<button type="submit" />}
                  className="w-full cursor-pointer"
                >
                  Log out
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );
}
