"use client";

import { useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { trackMenuAction } from "@/app/(app)/actions";
import { TrackContextMenu } from "@/components/track-context-menu";
import type { Track } from "@/lib/spotify";

// The right-click menu for rows that know a song only by IDENTITY (name + artist) — the
// search results and the day table. The payloads deliberately carry no uri (bytes), so
// the menu resolves it on open through one indexed action (~10 rows) and appears when the
// answer lands — ~a round trip, well under the time a hand takes to leave the mouse.
// A song that isn't in the library store (played once from a foreign context, never
// synced) resolves to nothing; say so instead of showing dead items.
export function IdentityTrackMenu({
  name,
  artist,
  x,
  y,
  onClose,
}: {
  name: string;
  artist: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [res, setRes] = useState<{
    track: Track;
    playlists: { id: string; name: string }[];
  } | null>(null);

  useEffect(() => {
    let dead = false;
    trackMenuAction(name, artist)
      .then((r) => {
        if (dead) return;
        if (r.ok) setRes({ track: r.track, playlists: r.playlists });
        else {
          toast.error(r.error);
          onClose();
        }
      })
      .catch(() => {
        if (!dead) {
          toast.error("Couldn't load the menu");
          onClose();
        }
      });
    return () => {
      dead = true;
    };
    // Resolve once per open; the identity cannot change while the menu exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!res) return null;
  return (
    <TrackContextMenu
      track={res.track}
      x={x}
      y={y}
      onClose={onClose}
      withPlay
      playOnly
      playFrom={res.playlists}
    />
  );
}
