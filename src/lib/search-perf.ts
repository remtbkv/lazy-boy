// Opt-in, console-only timing for the Home search box. Server logs cannot answer "how long did
// my search take": the request durations they hold are not the wait, because matching happens
// in this browser against the client-side index and the rows are painted here (db.ts, "The
// client-side search index"). So the measurement has to live where the pixels do.
//
// Enable:  visit /home?perf=1 once (it sticks), or localStorage.setItem("lb-perf", "1")
// Disable: /home?perf=0, or localStorage.removeItem("lb-perf")
//
// This is the ablation harness that measured the art variants, kept: same paint detection
// (a frame is only "painted" after the second requestAnimationFrame following the change) and
// the same image-load accounting, so numbers from the console are comparable with the ones in
// the commit history.
const FLAG = "lb-perf";

let enabled: boolean | null = null;

/** Read once per page. Everything else in this file is behind this, so with the flag off the
 *  cost of the whole readout is one boolean. */
export function searchPerfEnabled(): boolean {
  if (enabled !== null) return enabled;
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("perf");
    if (q === "1") window.localStorage.setItem(FLAG, "1");
    if (q === "0") window.localStorage.removeItem(FLAG);
    enabled = window.localStorage.getItem(FLAG) === "1";
  } catch {
    enabled = false; // private mode / storage disabled — measuring is never worth an exception
  }
  return enabled;
}

/** Where the query was answered from, as the search box saw it at the keystroke. */
export type IndexStatus = "memory" | "fetching" | "fallback";

/** Time one query, from the keystroke that produced it to the moment its rows, art and stats
 *  are on screen, then log a single line.
 *
 *  Returns a cancel function. Each keystroke supersedes the previous probe, so only the LAST
 *  one in a burst survives to log — which is what makes the numbers read as "after I stopped
 *  typing". A cancelled probe logs nothing.
 *
 *  The DOM contract is four data attributes on the results container (den-home.tsx):
 *  `data-search-results`, `data-query` (which query the DOM currently reflects — without it a
 *  probe would mark the previous query's rows as its own), `data-rows`, `data-hydrated`. */
export function startSearchProbe(query: string, index: IndexStatus): () => void {
  const t0 = performance.now();
  const rel = (t: number | null) => (t == null ? "—" : `${Math.round(t - t0)}ms`);

  let raf = 0;
  let finished = false;
  let painted: number | null = null;
  let art1: number | null = null;
  let artAll: number | null = null;
  let stats: number | null = null;
  let rowCount = 0;
  let stable = 0;
  let lastTracked = -1;
  // element → the time its pixels were available, or null while still loading.
  const imgs = new Map<HTMLImageElement, number | null>();

  const onScreen = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  };

  const track = (img: HTMLImageElement) => {
    if (imgs.has(img)) return;
    if (img.complete && img.naturalWidth > 0) {
      imgs.set(img, performance.now());
      return;
    }
    imgs.set(img, null);
    const settle = () => imgs.set(img, performance.now());
    img.addEventListener("load", settle, { once: true });
    // A broken image resolves too, or one 404 would stall the readout forever.
    img.addEventListener("error", settle, { once: true });
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    // Art already in the browser cache is decoded before its row exists, so its raw timestamp
    // can land BEFORE the row's — which would read as art arriving ahead of the rows it sits
    // in. Its pixels actually appear with the row, so that is the floor.
    if (painted != null) {
      if (art1 != null) art1 = Math.max(art1, painted);
      if (artAll != null) artAll = Math.max(artAll, painted);
    }
    console.log(
      `[lb-perf] “${query}” rows=${rowCount} paint=${rel(painted)} art1=${rel(art1)} ` +
        `artAll=${rel(artAll)} stats=${rel(stats)} index=${index}`,
    );
  };

  // Only count a mark once the frame carrying it has actually been presented.
  const afterPaint = (set: () => void) => {
    requestAnimationFrame(() => requestAnimationFrame(set));
  };

  const tick = () => {
    const el = document.querySelector<HTMLElement>("[data-search-results]");
    // Not our query on screen yet (or the box was cleared) — keep waiting.
    if (el && el.dataset.query === query) {
      rowCount = Number(el.dataset.rows ?? 0);
      if (painted == null) afterPaint(() => (painted ??= performance.now()));
      const hydrated = el.dataset.hydrated;
      if (stats == null && hydrated === "1") {
        afterPaint(() => (stats ??= performance.now()));
      }
      // "x" = the stats request failed, so there is nothing further to wait for. The line still
      // gets logged, with a dash where the number would be.
      const answered = stats != null || hydrated === "x";
      // Art that is off-screen is never fetched at all (the rows use loading="lazy"), so
      // "all art" means all art you can actually see.
      const shown = [...el.querySelectorAll("img")].filter(onScreen);
      shown.forEach(track);
      const times = shown.map((i) => imgs.get(i) ?? null);
      if (art1 == null && times.some((t) => t != null)) {
        art1 = Math.min(...(times.filter((t) => t != null) as number[]));
      }
      if (shown.length > 0 && times.every((t) => t != null)) {
        // Hold for a few frames: rows can still be arriving, and an early "all done" on the
        // first row alone would be a lie.
        stable = shown.length === lastTracked ? stable + 1 : 0;
        lastTracked = shown.length;
        if (stable >= 3 && artAll == null) artAll = Math.max(...(times as number[]));
      } else {
        stable = 0;
        lastTracked = shown.length;
      }
      const artDone = shown.length === 0 ? answered : artAll != null;
      if (answered && artDone) return finish();
    }
    if (performance.now() - t0 > 20_000) return finish(); // never leave a loop running
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    finished = true; // superseded by a newer keystroke: cancel silently
    cancelAnimationFrame(raf);
  };
}
