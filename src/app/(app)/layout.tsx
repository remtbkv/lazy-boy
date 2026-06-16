import { redirect } from "next/navigation";
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
