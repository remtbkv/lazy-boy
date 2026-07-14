"use client";

import { useEffect, useState } from "react";
import { dockDataAction, type DockData } from "../history-actions";
import { ActionDock } from "./dock";

// The dock renders instantly with an empty library, then fills it in from a background fetch.
// Nothing on first paint needs the playlists — only the panel a click opens does, and by then
// this has long since resolved. Keeping it out of the server render is what lets the shell
// flush immediately instead of waiting on ~180 rows.
const EMPTY: DockData = { playlists: [], backupPref: false, syncedAt: null };

export function DockLoader() {
  const [data, setData] = useState<DockData>(EMPTY);

  useEffect(() => {
    let alive = true;
    dockDataAction().then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  return <ActionDock {...data} />;
}
