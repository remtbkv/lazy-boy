import Link from "next/link";
import { getSpotify } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function MePage() {
  const sp = await getSpotify();
  const [me, playlists] = await Promise.all([sp.me(), sp.myPlaylists()]);
  const owned = playlists.filter((p) => p.ownerId === me.id).length;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Hey, {me.displayName}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {playlists.length} playlists · {owned} created by you
          </p>
        </div>
        {me.product ? (
          <Badge variant={me.product === "premium" ? "default" : "secondary"}>
            {me.product}
          </Badge>
        ) : null}
      </div>

      <section className="grid gap-4 sm:grid-cols-2">
        <ToolCard
          href="/playlists"
          title="Playlist tools"
          desc="Merge, clean, save your queue, and mirror your liked songs."
        />
        <ToolCard
          href="/compare"
          title="Compare a friend"
          desc="See which of their songs you don't have yet — and save the diff."
        />
        <ToolCard
          href="/playlists"
          title="Find duplicates"
          desc="Open any playlist to spot and remove duplicate tracks."
        />
        <ToolCard
          href="/friends"
          title="Friends"
          desc="Coming soon: see what friends play and queue songs for each other."
        />
      </section>
    </div>
  );
}

function ToolCard({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="group">
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{desc}</CardDescription>
        </CardHeader>
        <CardContent>
          <span className="text-sm font-medium text-primary">Open →</span>
        </CardContent>
      </Card>
    </Link>
  );
}
