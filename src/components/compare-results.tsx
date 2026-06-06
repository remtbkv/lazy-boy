"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { saveCompareDiffAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { CompareEntry } from "@/lib/spotify";

export function CompareResults({
  displayName,
  entries,
}: {
  displayName: string;
  entries: CompareEntry[];
}) {
  const totalUnsaved = entries.reduce((n, e) => n + e.unsaved.length, 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {displayName} · {entries.length} playlists · {totalUnsaved} songs you don&apos;t
        have yet
      </p>
      {entries.map((entry) => (
        <EntryCard key={entry.playlist.id} entry={entry} />
      ))}
    </div>
  );
}

function EntryCard({ entry }: { entry: CompareEntry }) {
  const [tab, setTab] = useState<"unsaved" | "saved">("unsaved");
  const [pending, startTransition] = useTransition();
  const list = tab === "unsaved" ? entry.unsaved : entry.saved;

  function saveDiff() {
    const uris = entry.unsaved.map((t) => t.uri);
    startTransition(async () => {
      const res = await saveCompareDiffAction(
        `Unsaved from ${entry.playlist.name}`,
        uris,
      );
      if (res.ok) toast.success(`Saved ${res.count} songs to a new playlist`);
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="min-w-0 truncate text-base">
          {entry.playlist.name}
        </CardTitle>
        <Button
          size="sm"
          onClick={saveDiff}
          disabled={pending || entry.unsaved.length === 0}
        >
          {pending ? "Saving…" : `Save ${entry.unsaved.length} unsaved`}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <FilterChip active={tab === "unsaved"} onClick={() => setTab("unsaved")}>
            Unsaved {entry.unsaved.length}
          </FilterChip>
          <FilterChip active={tab === "saved"} onClick={() => setTab("saved")}>
            Saved {entry.saved.length}
          </FilterChip>
        </div>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <ul className="thin-scroll max-h-64 space-y-1 overflow-y-auto pr-1">
            {list.map((t, i) => (
              <li key={`${t.id}-${i}`} className="flex items-baseline gap-2 text-sm">
                <span className="truncate">{t.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t.artist}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-secondary text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
