import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { login } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";

export default async function LoginPage() {
  const session = await auth();
  if (session && !session.error) redirect("/home");

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-3">
          <img
            src="/lazyboy-recliner.svg"
            alt="Lazy Boy"
            className="mx-auto w-44"
          />
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
