import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function FriendsPage() {
  return (
    <div className="space-y-8">
      <h1 className="text-4xl font-bold tracking-tight">Later stuff</h1>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">On the roadmap</CardTitle>
          <CardDescription>See docs/ROADMAP.md, Phase 3.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>· Compare libraries with a friend — once they&apos;re on Lazy Boy too, see which songs each of you is missing and save the diff.</p>
          <p>· Let friends queue songs for you — held and delivered when you next have an active device.</p>
          <p>· A shared listening view backed by the persistent song store.</p>
        </CardContent>
      </Card>
    </div>
  );
}
