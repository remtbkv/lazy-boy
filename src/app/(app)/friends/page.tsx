import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function FriendsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Friends</h1>
        <p className="mt-1 text-muted-foreground">Coming soon.</p>
      </div>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">On the roadmap</CardTitle>
          <CardDescription>See docs/ROADMAP.md, Phase 3.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>· See what a friend is currently playing.</p>
          <p>· Let friends queue songs for you, with a Do-Not-Disturb toggle.</p>
          <p>· A shared listening view backed by the persistent song store.</p>
        </CardContent>
      </Card>
    </div>
  );
}
