import { getSpotify } from "@/lib/session";
import { SpotifyError } from "@/lib/spotify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CompareResults } from "@/components/compare-results";

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user } = await searchParams;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Compare a friend</h1>
        <p className="mt-1 text-muted-foreground">
          Paste a Spotify profile link or user ID to see, per playlist, which songs you
          don&apos;t already have — then save that diff.
        </p>
      </div>

      <form action="/compare" className="flex max-w-xl gap-2">
        <Input
          name="user"
          defaultValue={user ?? ""}
          placeholder="https://open.spotify.com/user/…  or  user id"
          aria-label="Spotify profile link or user id"
        />
        <Button type="submit">Compare</Button>
      </form>

      {user ? <Results user={user} /> : null}
    </div>
  );
}

async function Results({ user }: { user: string }) {
  const sp = await getSpotify();

  let data: Awaited<ReturnType<typeof sp.compareUser>> | null = null;
  let error: string | null = null;
  try {
    data = await sp.compareUser(user);
  } catch (e) {
    error =
      e instanceof SpotifyError && e.status === 404
        ? "No such user, or their profile isn't public."
        : e instanceof Error
          ? e.message
          : "Failed to compare.";
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data || data.entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {data?.user.displayName ?? "This user"} has no public playlists to compare.
      </p>
    );
  }
  return <CompareResults displayName={data.user.displayName} entries={data.entries} />;
}
