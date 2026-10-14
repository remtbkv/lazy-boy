"use client";

import { useEffect, useRef, useState } from "react";
import { dockDataAction, type DockData } from "../history-actions";
import { ActionDock } from "./dock";

// The dock renders instantly with an empty library, then fills it in from a background fetch.
// Nothing on first paint needs the playlists — only the panel a click opens does, and by then
// this has long since resolved. Keeping it out of the server render is what lets the shell
// flush immediately instead of waiting on ~180 rows.
const EMPTY: DockData = { playlists: [], backupPref: false, syncedAt: null };

export function DockLoader() {
  const [data, setData] = useState<DockData>(EMPTY);
  // A failed load used to leave every sheet on "Loading your playlists…" for the visit (burn
  // review 2026-10-03, U1). It is retried when a sheet opens, or from the sheet's Retry.
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const loading = useRef(false);

  const load = () => {
    if (loading.current) return;
    loading.current = true;
    setFailed(false);
    dockDataAction()
      .then(
        (d) => {
          if (!alive.current) return;
          setData(d);
          // The one part of Home that is genuinely a second round trip, so it gets its own
          // mark (read by src/lib/metrics-client.ts, shown on /usage). Marked on arrival
          // rather than on the next paint: nothing on screen changes until a panel is opened,
          // so "arrived" is the whole readiness story here.
          performance.mark("lb:dock-ready");
        },
        () => {
          if (alive.current) setFailed(true);
        },
      )
      .finally(() => {
        loading.current = false;
      });
  };

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, []);

  return <ActionDock {...data} loadFailed={failed} onRetry={load} />;
}
