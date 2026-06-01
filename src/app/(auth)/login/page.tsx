import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { login } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";

export default async function LoginPage() {
  const session = await auth();
  if (session && !session.error) redirect("/me");

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-3">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <SpotifyGlyph />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Spotify Claude Manager
          </h1>
          <p className="text-sm text-muted-foreground">
            Merge, clean, and compare your playlists. Connect your Spotify account to
            get started.
          </p>
        </div>
        <form action={login}>
          <Button type="submit" size="lg" className="w-full font-medium">
            Connect Spotify
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          We only access your library to manage playlists. Nothing is shared.
        </p>
      </div>
    </main>
  );
}

function SpotifyGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.4a.62.62 0 0 1-.86.21c-2.35-1.44-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.22c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.21.86Zm1.23-2.73a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.49c3.64-1.1 8.16-.56 11.24 1.33.36.22.48.7.25 1.07Zm.11-2.85C14.83 8.96 9.4 8.78 6.3 9.72a.94.94 0 1 1-.54-1.8c3.56-1.08 9.56-.87 13.33 1.37a.94.94 0 0 1-.96 1.61Z" />
    </svg>
  );
}
