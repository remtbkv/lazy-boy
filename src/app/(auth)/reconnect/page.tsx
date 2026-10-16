import { login } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";

// Decision 20 as ruled (RULINGS Oct 15 1:17 PM): a session whose Spotify grant has died gets a
// short, helpful error saying what happened and what to do, then the sign-in; never a silent
// redirect. No session read here: the gated pages send a dead grant to this page.
export default function ReconnectPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 text-center text-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Spotify needs you to sign in again</h1>
        <p>
          Spotify stopped accepting Lazy Boy&apos;s sign-in for your account, so Lazy Boy has stopped recording your
          listening. Your history so far is kept.
        </p>
        <p>
          Sign in again to pick up where you left off. Songs you played in the meantime come back only as far as
          Spotify&apos;s recently played list reaches: your last 50.
        </p>
        <form action={login}>
          <Button type="submit" size="lg" className="w-full font-medium">
            Sign in again
          </Button>
        </form>
        <p className="text-muted-foreground">
          If you removed Lazy Boy from your Spotify account on purpose, that counts as leaving: unless you sign in again,
          a friend&apos;s data is deleted after four days.
        </p>
      </div>
    </main>
  );
}
