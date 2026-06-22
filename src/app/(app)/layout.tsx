import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { Header } from "@/components/header";
import { CleanProgressWatcher } from "@/components/clean-progress";
import { SyncOnLoad } from "@/components/sync-on-load";
import { TimezoneCookie } from "@/components/timezone-cookie";
import { NowPlayingProvider } from "@/components/now-playing-context";
import { ScrollbarHover } from "@/components/scrollbar-hover";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The session cookie is pinned to 127.0.0.1, so on `localhost` auth() sees no session and
  // would detour through /login (a full server render) before the root-layout canonicalizer
  // bounces to 127.0.0.1. Skip that: render nothing here and let the canonicalizer jump
  // straight to 127.0.0.1, where the cookie exists and the real page loads. No-op everywhere
  // else (127.0.0.1, the deployed domain).
  const host = (await headers()).get("host") ?? "";
  if (host.startsWith("localhost")) return null;

  const session = await auth();
  if (!session || session.error) redirect("/login");

  return (
    <NowPlayingProvider>
      <Header
        name={session.user?.name ?? "You"}
        image={session.user?.image ?? null}
      />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
      <CleanProgressWatcher />
      <SyncOnLoad />
      <TimezoneCookie />
      <ScrollbarHover />
    </NowPlayingProvider>
  );
}
