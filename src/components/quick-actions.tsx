"use client";

import { saveQueueAction, syncLikedAction } from "@/app/(app)/actions";
import { ActionButton } from "@/components/action-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function QuickActions() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Save current queue</CardTitle>
          <CardDescription>
            Snapshot what&apos;s playing next into a &quot;Saved queue&quot; playlist.
            Needs an active device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionButton
            action={saveQueueAction}
            pendingText="Saving…"
            success={(r) => `Saved ${r.count} tracks to "${r.name}"`}
            className="w-full"
          >
            Save queue
          </ActionButton>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mirror liked songs</CardTitle>
          <CardDescription>
            Keep a &quot;Liked songs as playlist&quot; in sync with your liked songs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionButton
            action={syncLikedAction}
            pendingText="Syncing…"
            success={(r) => `"${r.name}" now has ${r.count} songs`}
            variant="secondary"
            className="w-full"
          >
            Sync liked songs
          </ActionButton>
        </CardContent>
      </Card>
    </div>
  );
}
