"use client";

import { useState } from "react";
import { SearchIsland } from "../(app)/search-island";

// Dummy library — enough rows to scroll, names that filter meaningfully.
const SONGS = Array.from({ length: 60 }, (_, i) => {
  const words = ["Milk", "Shake", "River", "Neon", "Paper", "Static", "Velvet", "Echo"];
  return `${words[i % words.length]} ${words[(i + 3) % words.length]} ${i + 1}`;
});

export function KbTest() {
  const [q, setQ] = useState("");
  const shown = SONGS.filter((s) => s.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <main className="mx-auto flex h-dvh w-full max-w-5xl flex-col gap-3 overflow-hidden px-4 pb-20 pt-4">
      <h1 className="shrink-0 text-lg font-semibold">Keyboard test (dev only)</h1>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border">
        {shown.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing matches “{q.trim()}”.</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {shown.map((s) => (
              <li key={s} className="px-3 py-2.5 text-sm">
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
      <SearchIsland query={q} onQuery={setQ} placeholder="Search your songs…" />
    </main>
  );
}
