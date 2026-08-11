import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals";

// Self-hosted RUM: what the browser actually measured on this page load, posted to
// /api/metrics and stored in `client_metrics` (db.ts, "Client performance metrics"). No
// third party sees any of it, and nothing here is sampled — this is a single-user app, so
// every real load is a data point worth having.
//
// WHAT IS RECORDED, per view:
//   pageview                    one per view (hard load and soft navigation alike)
//   ttfb / fcp / lcp            web-vitals, attributed to the page the browser LOADED —
//                               they resolve late, and a soft nav in the meantime must not
//                               reassign them to a page that never paid for them
//   inp / cls                   the two vitals LCP cannot see: how long the app took to
//                               answer a tap, and how far the layout moved under the reader.
//                               Both are final only when the view is hidden, so web-vitals
//                               reports them on visibilitychange/pagehide — registered BEFORE
//                               our own pagehide flush so the value is in the buffer when the
//                               beacon goes out
//   js-error                    an uncaught error or rejected promise, message (truncated) in
//                               `meta`. Capped per view: a throw inside a render loop must
//                               not become a beacon loop
//   <name>                      any `performance.mark("lb:<name>")` the app makes, recorded
//                               as event `<name>` with value = MS SINCE THIS VIEW BEGAN, not
//                               since the document loaded. On a hard load the two are the same
//                               number; on a soft navigation the raw mark carries however long
//                               the tab had already been open, which made "how fast did the
//                               song list render" unreadable the moment you arrived from
//                               another page. Generic on purpose: app code emits marks, this
//                               file never has to know which ones exist (currently
//                               lb:data-rendered, lb:history-ready, lb:dock-ready,
//                               lb:playlists-rendered, lb:now-playing-ready).
//   visit-ms                    time the view spent VISIBLE, accumulated across
//                               visibilitychange, closed out on navigation and on pagehide
//   nav-ms                      soft navigation: click on an in-app link → the new route
//                               rendering, filed against the page navigated FROM, with the
//                               destination in `meta`
//
// GROUPING: every event carries the id of the VIEW it belongs to, as a `pv:<id>` prefix on
// `meta` (a prefix rather than a column, so a row written before this existed still reads —
// it just has no view to belong to). Session + page alone cannot group one page OPEN: a sitting
// in one tab opens Home repeatedly, and the rows of one open reach the server in one or two
// beacons mixed with the previous view's. The id is what lets the usage page show "this open,
// at 3:41pm, took 210ms to paint and 900ms to have its history in memory" instead of only a
// percentile over everything.
//
// DELIVERY: events buffer and go out via navigator.sendBeacon — on pagehide (the only
// reliable "the tab is going away" hook) and once ~10s after load, so a visit that ends
// before LCP resolves still reports the vitals it did get. Beacons carry the session cookie,
// which is what lets /api/metrics require auth().
//
// Every entry point swallows its own errors. An instrument that can break the app it
// measures is worse than no instrument.

const ENDPOINT = "/api/metrics";
const MARK_PREFIX = "lb:";
const PV_TAG = "pv:"; // `meta` prefix that files a row under one page open (db.ts parses it)
const SESSION_KEY = "lb:metrics-session";
const FLUSH_AFTER_LOAD_MS = 10_000;
const MAX_BATCH = 50; // the route rejects more than this in one body
const MAX_BUFFER = 200; // a runaway mark loop must not grow the buffer without bound
const MAX_ERRORS = 5; // per tab: the first few throws say what broke, the rest are the echo
const MAX_ERROR_CHARS = 180; // the route truncates `meta` at 200 anyway

type MetricEvent = { page: string; event: string; value?: number; meta?: string };

let started = false;
let buffer: MetricEvent[] = [];
let sessionMemo = "";
let page = ""; // the view being measured now
let loadPage = ""; // the view the browser loaded, which owns the vitals
let pv = ""; // id of the view being measured now
let loadPv = ""; // id of the loaded view, so the vitals group with the open that earned them
let viewStart = 0; // performance.now() when the current view began; 0 for the loaded view
let visibleSince = 0; // performance.now() when this view last became visible; 0 while hidden
let visibleMs = 0; // visible time accumulated for this view
let pendingNav: { path: string; at: number } | null = null;
let errorsRecorded = 0;

/** Stable per-tab id. sessionStorage so a reload starts a new one — a "session" here means
 *  one sitting in one tab, which is the unit a slow page is experienced in. */
function sessionId(): string {
  if (sessionMemo) return sessionMemo;
  try {
    sessionMemo = sessionStorage.getItem(SESSION_KEY) ?? "";
    if (!sessionMemo) {
      sessionMemo = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, sessionMemo);
    }
  } catch {
    sessionMemo = crypto.randomUUID(); // private mode / storage blocked: in-memory is enough
  }
  return sessionMemo;
}

/** Collapse the id-bearing routes (/playlists/<22-char id>) onto one key, or the summary
 *  gets one row per playlist ever opened and says nothing about the page. */
function normalizePage(path: string): string {
  return path.replace(/\/[A-Za-z0-9]{16,}(?=\/|$)/g, "/[id]");
}

/** Short, per-view, and only ever compared to itself — no need for a uuid's guarantees. */
function newViewId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** `forPage`/`forPv` file a row against a view OTHER than the current one — the loaded view
 *  for the vitals, the view being left for its visit time. */
function record(
  event: string,
  value?: number,
  meta?: string,
  forPage?: string,
  forPv?: string,
): void {
  if (buffer.length >= MAX_BUFFER) return;
  const view = forPv || pv;
  const tagged = view ? (meta ? `${PV_TAG}${view}|${meta}` : `${PV_TAG}${view}`) : meta;
  buffer.push({ page: forPage || page, event, value, meta: tagged });
}

function flush(): void {
  try {
    while (buffer.length) {
      const batch = buffer.slice(0, MAX_BATCH);
      buffer = buffer.slice(MAX_BATCH);
      const body = JSON.stringify({ session: sessionId(), events: batch });
      const blob = new Blob([body], { type: "application/json" });
      if (!navigator.sendBeacon?.(ENDPOINT, blob)) {
        // sendBeacon refuses over its queue limit; keepalive fetch is the same guarantee.
        void fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    }
  } catch {
    /* a metric that can't be sent is not worth an exception in the app */
  }
}

function startVisible(): void {
  if (!visibleSince && document.visibilityState === "visible") visibleSince = performance.now();
}

function stopVisible(): void {
  if (visibleSince) {
    visibleMs += performance.now() - visibleSince;
    visibleSince = 0;
  }
}

function onVisibility(): void {
  if (document.visibilityState === "visible") startVisible();
  else stopVisible();
}

function onPageHide(): void {
  stopVisible();
  if (page) record("visit-ms", visibleMs);
  flush();
}

/** File one uncaught error against the view it happened on. The cap is the whole safety
 *  story: an error thrown from a render or an interval would otherwise report on every
 *  repetition, and the reporting path itself can throw — so this never runs its own work
 *  outside the try. */
function onError(message: unknown): void {
  try {
    if (errorsRecorded >= MAX_ERRORS) return;
    errorsRecorded += 1;
    const text = typeof message === "string" ? message : String(message ?? "unknown");
    record("js-error", undefined, text.slice(0, MAX_ERROR_CHARS));
  } catch {
    /* an instrument that throws while reporting a throw is worse than the original error */
  }
}

/** A capture-phase click on an in-app link starts the soft-navigation clock; setPage() stops
 *  it when the destination actually renders. Cheap and honest — it measures what the user
 *  waited through. A click that never lands (a new page, an aborted nav) just expires. */
function onClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link || link.target === "_blank" || link.origin !== location.origin) return;
  pendingNav = { path: normalizePage(link.pathname), at: performance.now() };
}

/** Tell the collector which view is on screen. Called on mount and on every soft navigation;
 *  the first call fixes the page the vitals belong to. */
export function setPage(path: string): void {
  const next = normalizePage(path);
  if (next === page) return;
  const from = page;
  const fromPv = pv;
  pv = newViewId();
  if (from) {
    // Close out the view being left: its visible time is final now.
    stopVisible();
    record("visit-ms", visibleMs, undefined, from, fromPv);
    visibleMs = 0;
    startVisible();
    // Marks from here on are measured against the arrival, not the document.
    viewStart = performance.now();
  } else {
    loadPage = next;
    loadPv = pv;
  }
  page = next;
  record("pageview");
  if (pendingNav && pendingNav.path === next) {
    // Filed against the page navigated FROM (that is whose link was slow to leave), but under
    // the ARRIVING view's id — it is the one number that says how long this open waited before
    // it began, so it belongs in that open's row on the usage page.
    record("nav-ms", performance.now() - pendingNav.at, next, from || next, pv);
  }
  pendingNav = null;
}

/** Wire the observers once per tab. Idempotent — a second call (StrictMode's double mount)
 *  does nothing. */
export function startMetrics(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    startVisible();
    // The vitals belong to the loaded page, whatever is on screen when they resolve.
    onTTFB((m) => record("ttfb", m.value, undefined, loadPage, loadPv));
    onFCP((m) => record("fcp", m.value, undefined, loadPage, loadPv));
    onLCP((m) => record("lcp", m.value, undefined, loadPage, loadPv));
    // INP and CLS accumulate across the whole visit, so they belong to the loaded page for
    // the same reason the others do, and they arrive at hide time — before the pagehide
    // flush below, which is registered after these.
    onINP((m) => record("inp", m.value, undefined, loadPage, loadPv));
    onCLS((m) => record("cls", m.value, undefined, loadPage, loadPv));

    // `buffered: true` replays marks made before this ran, so app code can mark during its
    // first render without caring when the collector mounted.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith(MARK_PREFIX)) continue;
        // Relative to the view, not the document (see the header note). A part that renders
        // as the soft navigation lands marks a hair before setPage moves the origin, hence
        // the clamp — it reads as 0ms, which is what it was: already there on arrival.
        record(entry.name.slice(MARK_PREFIX.length), Math.max(0, entry.startTime - viewStart));
      }
    }).observe({ type: "mark", buffered: true });

    window.addEventListener("error", (e) => onError(e.message));
    window.addEventListener("unhandledrejection", (e) => onError(e.reason));
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    // The one-shot flush: LCP and the late marks have settled by now, and a visit that ends
    // without a usable pagehide (mobile task-switch, crash) has still reported them.
    setTimeout(flush, FLUSH_AFTER_LOAD_MS);
  } catch {
    /* an unsupported API here just means fewer metrics, never a broken page */
  }
}
