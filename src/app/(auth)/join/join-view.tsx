import Link from "next/link";
import { login } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import type { RequestState } from "@/lib/app-db";

const ERRORS: Record<string, string> = {
  closed: "Lazy Boy isn't taking requests right now.",
  terms: "Tick the box to accept the Privacy Policy and Terms first.",
  email: "That doesn't look like an e-mail address.",
  name: "That name is too long.",
  duplicate: "A request for that address is already waiting. Rem will be in touch.",
  busy: "Too many requests just now. Try again in an hour.",
  full: "Lazy Boy is full: Spotify lets it have five people, Rem included.",
  link: "That link has expired or was already used. Ask Rem for a new one.",
  unavailable: "Something went wrong on our side. Try again in a minute.",
};

function Consent() {
  return (
    <p className="mt-3 text-xs text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">
      By connecting your Spotify account you agree to the <Link href="/terms">Terms</Link> and the{" "}
      <Link href="/privacy">Privacy Policy</Link>.
    </p>
  );
}

// PLAN.md §12.6, as the rulings change it (Oct 15: kept while connected, no idle pause, no
// twelve-month deletion; Log out and Disconnect; friends are not backed up).
function WhatYouGet() {
  return (
    <div className="space-y-3 text-left text-sm text-muted-foreground [&_strong]:text-foreground">
      <p>
        <strong>What works:</strong> your own listening history and day view, search over your library and history,
        cleaning and merging playlists, the all-time card, and your Liked Songs mirrored.
      </p>
      <p>
        <strong>What needs your own Spotify Premium:</strong> starting playback, queueing, resuming and playing from a
        playlist.
      </p>
      <p>
        <strong>Where your history starts:</strong> the first sync stores your last 50 plays; nothing earlier comes in.
        The first library scan takes a minute or two, so the day strip and the all-time card start nearly empty.
      </p>
      <p>
        <strong>What can be lost:</strong> Lazy Boy reads what you play every couple of minutes, even with the app
        closed. If that stops (you log out, Spotify&apos;s permission lapses, a long outage), only your last 50 plays
        can be fetched afterwards; anything older is gone unless you export it from Spotify.
      </p>
      <p>
        <strong>Your data:</strong> kept while you stay connected. Log out stops the recording; Disconnect deletes
        everything within five days. Your data is not backed up. Rem runs the servers and can technically read it.
      </p>
      <p>
        <strong>Five people in all</strong>, Rem included: that is Spotify&apos;s limit for an app like this.
      </p>
    </div>
  );
}

export function JoinView({ state, error }: { state: RequestState; error?: string }) {
  const failed = error ? (ERRORS[error] ?? null) : null;
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Join Lazy Boy</h1>
        {failed && (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {failed}
          </p>
        )}
        {state === "pending" && (
          <p className="text-sm">
            Your request is in. Rem adds your Spotify e-mail to the app and approves it, then sends you a link. You can
            close this page.
          </p>
        )}
        {state === "approved" && (
          <form action={login}>
            <p className="mb-4 text-sm">Rem approved your request. Connect the Spotify account with the e-mail you gave.</p>
            <Button type="submit" size="lg" className="w-full font-medium">
              Connect Spotify
            </Button>
            <Consent />
          </form>
        )}
        {state === "claimed" && (
          <p className="text-sm">
            Your account is connected. <Link href="/login">Sign in</Link>.
          </p>
        )}
        {state === null && (
          <>
            <WhatYouGet />
            <form method="post" action="/api/join" className="space-y-3 text-left">
              <label className="block text-sm">
                The e-mail on your Spotify account
                <input name="email" type="email" required maxLength={254} className="mt-1 w-full rounded-md border px-3 py-2" />
              </label>
              <label className="block text-sm">
                Your name (optional)
                <input name="name" maxLength={80} className="mt-1 w-full rounded-md border px-3 py-2" />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input name="agree" type="checkbox" required className="mt-1" />
                <span className="[&_a]:underline [&_a]:underline-offset-4">
                  I have read and accept the <Link href="/privacy">Privacy Policy</Link> and the{" "}
                  <Link href="/terms">Terms</Link>.
                </span>
              </label>
              <Button type="submit" size="lg" className="w-full font-medium">
                Ask to join
              </Button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
