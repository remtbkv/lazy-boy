import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { login } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { ClearUserStorage } from "@/components/clear-user-storage";
import { loginErrorMessage } from "@/lib/login-error";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; on?: string | string[] }>;
}) {
  const session = await auth();
  if (session && !session.error) redirect("/home");
  const { error, on } = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const failed = loginErrorMessage(first(error), first(on));

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      {/* No signed-in user reaches here (a live session is sent to /home above): a browser whose
          session ended elsewhere (Log out on another browser, a Disconnect, a deletion) forgets
          every user's stored data on this visit, as PLAN §6.2 layer 6 promises at the next request. */}
      <ClearUserStorage />
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-3">
          <img
            src="/lazyboy-recliner.svg"
            alt="Lazy Boy"
            className="mx-auto w-44"
          />
          <h1 className="text-2xl font-semibold tracking-tight">
            Lazy Boy
          </h1>
          <p className="text-sm text-muted-foreground">
            Merge, clean, and compare your playlists. Connect your Spotify account to
            get started.
          </p>
        </div>
        {failed && (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {failed}
          </p>
        )}
        <form action={login}>
          <Button type="submit" size="lg" className="w-full font-medium">
            Connect Spotify
          </Button>
          <p className="mt-3 text-xs text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">
            By connecting your Spotify account you agree to the <Link href="/terms">Terms</Link>{" "}
            and the <Link href="/privacy">Privacy Policy</Link>.
          </p>
        </form>
        <p className="text-xs text-muted-foreground">
          Lazy Boy reads your library and records what you play, for you alone. Nothing is shared.
        </p>
      </div>
    </main>
  );
}
