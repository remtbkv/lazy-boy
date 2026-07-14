"use client";

import { useEffect, useState } from "react";
import { dockDataAction, type DockData } from "@/app/(app)/history-actions";
import { ActionDock } from "./dock";

// Feeds the draft's ORIGINAL dock — the one whose sheets are mocks. Same background fetch as
// the shipped one; it just hands the playlists to the draft's sheet instead of the real panels.
export function DockLoader() {
  const [playlists, setPlaylists] = useState<DockData["playlists"]>([]);

  useEffect(() => {
    let alive = true;
    dockDataAction().then((d) => {
      if (alive) setPlaylists(d.playlists);
    });
    return () => {
      alive = false;
    };
  }, []);

  return <ActionDock playlists={playlists} />;
}
