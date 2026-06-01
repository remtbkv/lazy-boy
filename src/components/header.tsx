"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/(app)/actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
  { href: "/me", label: "Me" },
  { href: "/playlists", label: "Playlists" },
  { href: "/friends", label: "Friends" },
];

export function Header({ name, image }: { name: string; image: string | null }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-6 px-4 sm:px-6">
        <Link href="/me" className="flex items-center gap-2 font-semibold">
          <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.4a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.21.86Zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.49c3.64-1.1 8.16-.56 11.24 1.33.36.22.48.7.25 1.07Z" />
            </svg>
          </span>
          <span className="hidden sm:inline">Manager</span>
        </Link>

        <nav className="flex items-center gap-1">
          {TABS.map((tab) => {
            const active =
              pathname === tab.href || pathname.startsWith(tab.href + "/");
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="flex items-center gap-2 px-2 hover:bg-secondary"
                />
              }
            >
              <Avatar className="size-7">
                {image ? <AvatarImage src={image} alt={name} /> : null}
                <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm sm:inline">{name}</span>
            </DropdownMenuTrigger>
            {/* No gap between trigger and content — fixes the prototype's
                unreachable-logout hover bug (future.txt high priority). */}
            <DropdownMenuContent align="end" sideOffset={4} className="w-44">
              <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <form action={logout}>
                <DropdownMenuItem
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
    </header>
  );
}
