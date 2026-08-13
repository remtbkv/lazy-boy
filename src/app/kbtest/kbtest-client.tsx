"use client";

import { useEffect, useState } from "react";
import { SearchIsland } from "../(app)/search-island";
import { usePhone, useSearchMode } from "../(app)/use-search-mode";

// A HOME-PAGE LOOKALIKE, not a bare list: same locked viewport, same bands (header /
// greeting / action pills / day tray / framed song box / search island), same classes —
// so a Simulator run exercises the exact geometry the real page has. Dummy data only;
// the one real component under test is SearchIsland.
//
// Instrumented: window.__kblog collects a sample every ~80ms — visual viewport height +
// offset, layout height, and the pill's on-screen position — so a run yields a numeric
// trace of what the keyboard did (pan vs resize, zoom, pill trajectory), not just pixels.

const SONGS = Array.from({ length: 60 }, (_, i) => {
  const words = ["Milk", "Shake", "River", "Neon", "Paper", "Static", "Velvet", "Echo"];
  return {
    title: `${words[i % words.length]} ${words[(i + 3) % words.length]} ${i + 1}`,
    artist: `Artist ${String.fromCharCode(65 + (i % 26))}`,
    time: `${(i % 12) + 1}:${String((i * 7) % 60).padStart(2, "0")} PM`,
  };
});

const DAYS = [
  { label: "Today", plays: 42, time: "2h 4m" },
  { label: "Yesterday", plays: 95, time: "4h 24m" },
  { label: "Aug 11", plays: 101, time: "5h 7m" },
  { label: "Aug 10", plays: 72, time: "4h 23m" },
];

type KbSample = {
  t: number;
  vvH: number;
  vvTop: number;
  vvScale: number;
  layoutH: number;
  pillTop: number | null;
};

export function KbTest() {
  const [q, setQ] = useState("");
  const [sample, setSample] = useState<KbSample | null>(null);
  const shown = SONGS.filter((s) => s.title.toLowerCase().includes(q.trim().toLowerCase()));

  // The REAL search-mode wiring under test — same hook DenHome uses: .den-searching on
  // the root (header + bands fold, main pinned to --lb-vvh) while focused or querying.
  const phone = usePhone();
  const [focused, setFocused] = useState(false);
  useSearchMode(phone && (focused || q.trim().length > 0), focused);

  useEffect(() => {
    const log: KbSample[] = [];
    (window as unknown as { __kblog: KbSample[] }).__kblog = log;
    const t0 = performance.now();
    const id = setInterval(() => {
      const vv = window.visualViewport;
      const inp = document.querySelector('input[aria-label^="Search"]');
      const rect = inp?.closest("div.fixed")?.getBoundingClientRect() ?? null;
      const s: KbSample = {
        t: Math.round(performance.now() - t0),
        vvH: Math.round(vv?.height ?? -1),
        vvTop: Math.round(vv?.offsetTop ?? -1),
        vvScale: Number((vv?.scale ?? 1).toFixed(3)),
        layoutH: document.documentElement.clientHeight,
        pillTop: rect ? Math.round(rect.top) : null,
      };
      log.push(s);
      if (log.length > 400) log.shift();
      setSample(s);
    }, 80);
    return () => clearInterval(id);
  }, []);

  return (
    <div id="den-root" className="flex h-dvh flex-col overflow-hidden">
      {/* Live trace, burned into the recording: the numbers that say what the keyboard
          actually did — visual-viewport height/offset/zoom scale, layout height, and where
          the pill is. This is what a run "keeps track of". */}
      {sample ? (
        <div className="pointer-events-none fixed left-1 top-14 z-[100] rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-green-400">
          vv {sample.vvH}+{sample.vvTop} · zoom {sample.vvScale} · layout {sample.layoutH} ·
          pill {sample.pillTop ?? "—"}
        </div>
      ) : null}
      {/* Header band, same bar as the app chrome. */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-4 px-4">
          <span className="size-9 rounded-full bg-secondary" />
          <nav className="flex items-center gap-0.5">
            {["Home", "Playlists", "Friends"].map((t, i) => (
              <span
                key={t}
                className={
                  "rounded-md px-2.5 py-1.5 text-[15px] font-medium " +
                  (i === 0 ? "text-foreground" : "text-muted-foreground/70")
                }
              >
                {t}
              </span>
            ))}
          </nav>
          <span className="ml-auto size-8 rounded-full bg-secondary" />
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 overflow-hidden px-4 pb-[calc(env(safe-area-inset-bottom)+4.25rem)] pt-5">
        <h1 className="den-display den-home-band shrink-0 text-4xl leading-tight tracking-tight">
          Keyboard test.
        </h1>

        {/* Action pills band. */}
        <div className="den-home-band flex shrink-0 snap-x gap-2 overflow-x-auto">
          {["Resume", "Clean", "Save queue", "Merge", "Subtract"].map((a) => (
            <span
              key={a}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-[13px] font-medium text-foreground/90"
            >
              {a}
            </span>
          ))}
        </div>

        {/* Day tray band. */}
        <div className="flex shrink-0 items-stretch gap-2">
          <div className="min-w-0 flex-1 rounded-xl border border-border/60 bg-white/[0.015] p-1.5 pb-1">
            <div className="flex snap-x gap-2 overflow-x-auto pb-1">
              {DAYS.map((d, i) => (
                <span
                  key={d.label}
                  className={
                    "flex w-[92px] min-w-[92px] shrink-0 flex-col justify-between rounded-xl border px-2.5 py-3 " +
                    (i === 0 ? "border-white/25 bg-white/[0.05]" : "border-border bg-card")
                  }
                >
                  <span className="text-sm font-semibold">{d.label}</span>
                  <span className="flex flex-col font-semibold tabular-nums">
                    <span className="text-2xl">{d.plays}</span>
                    <span className="text-xs font-normal text-muted-foreground">plays</span>
                  </span>
                  <span className="mt-1 text-xs tabular-nums text-muted-foreground">{d.time}</span>
                </span>
              ))}
            </div>
          </div>
          <span className="flex w-[92px] min-w-[92px] flex-col justify-between rounded-xl border border-border bg-card px-2.5 py-3">
            <span className="text-sm font-semibold">All time</span>
            <span className="flex flex-col font-semibold tabular-nums">
              <span className="text-2xl">7740</span>
              <span className="text-xs font-normal text-muted-foreground">plays</span>
            </span>
            <span className="mt-1 text-xs tabular-nums text-muted-foreground">421h 37m</span>
          </span>
        </div>

        {/* The framed song box — same scroll-to-dismiss as DenHome's results. */}
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60">
          <div
            className="h-full overflow-y-auto px-2.5"
            onTouchMove={() => {
              const el = document.activeElement;
              if (el instanceof HTMLInputElement) el.blur();
            }}
          >
            {shown.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No songs match “{q.trim()}”.
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {shown.map((s, i) => (
                  <li
                    key={s.title}
                    className="den-row flex items-center gap-3 py-2"
                    style={{ "--i": i } as React.CSSProperties}
                  >
                    <span className="size-10 shrink-0 rounded-md bg-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px]">{s.title}</span>
                      <span className="block truncate text-[13px] text-muted-foreground">
                        {s.artist}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
                        {s.time} · newer
                      </span>
                    </span>
                    <span className="pr-1 text-right tabular-nums text-muted-foreground">1</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>

      <SearchIsland
        query={q}
        onQuery={setQ}
        onFocusChange={setFocused}
        stayDocked={phone && (focused || q.trim().length > 0)}
        placeholder="Search your songs…"
      />
    </div>
  );
}
