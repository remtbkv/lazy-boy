// Low-level Spotify HTTP client. The single place that talks to api.spotify.com.
// Owns: auth header, JSON, pagination, 429/Retry-After backoff. No domain logic here.

import type { Paging } from "./types";
import { getApiLogSummary, logSpotifyRequest, setSpotifyCooldownUntil } from "@/lib/db";

const BASE = "https://api.spotify.com/v1";
const MAX_RETRIES = 3;
// 429 handling depends on who's calling. Interactive paths (opening a playlist,
// saving the queue, now-playing) must FAIL FAST and let the UI degrade — never
// hang for minutes. Background bulk work (cleaning a playlist scans the whole
// library) opts into "patient" mode to ride out throttling and finish. Per-wait
// caps bound how long any single wait can be.
const RATE_LIMIT_RETRIES = { fast: 3, patient: 12 };
const RETRY_AFTER_CAP_S = { fast: 5, patient: 30 };
// Spotify 403s both transiently (burst) and permanently (e.g. reading another user's
// playlist items while the app is in development mode). We can't tell them apart from
// the response, so retry only ONCE — enough to ride out a transient blip, but a real
// "forbidden" fails fast instead of burning calls and stalling the page.
const FORBIDDEN_RETRIES = 1;
// When Spotify's Retry-After is larger than this (seconds), it's a long ban, not a brief
// burst throttle — stop retrying immediately instead of hammering a banned endpoint.
const HARD_BAN_S = 120;
// A long ban is persisted so other serverless invocations back off too, but capped so we
// re-probe within a bounded window rather than staying dark for the full multi-hour wait
// Spotify sometimes demands. One probe per this interval can't sustain a ban.
const PERSIST_COOLDOWN_CAP_MS = 30 * 60 * 1000;
// A patient caller rides out short throttles by sleeping through them; past this it bails
// like an interactive one — sleeping minutes inside a serverless invocation helps nobody.
const PATIENT_MAX_COOLDOWN_WAIT_MS = 2 * 60 * 1000;

export class SpotifyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SpotifyError";
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared cooldown across ALL Spotify requests (module-scoped). When Spotify 429s, every
// request — polls, syncs, page loads — should back off, not keep hammering: that's how a
// brief throttle turns into a long block. A 429 sets this window; other requests check it
// first and either wait briefly (patient/bulk work) or fail fast (interactive), instead
// of all of them retrying into the throttle at once.
let cooldownUntil = 0;

// A bearer token, or a getter that returns a currently-valid one. Interactive callers
// pass the request's token (fresh for the request's lifetime); long-running background
// work passes a getter so a token that expires mid-run is refreshed, not used dead.
export type TokenSource = string | (() => Promise<string>);

export class HttpClient {
  // `patient` = ride out rate limits (background bulk work). Default false so
  // interactive callers fail fast.
  constructor(
    private token: TokenSource,
    private patient = false,
    /** WHO is calling and why — written into api_log per request, so a 429 can be
     *  attributed to its traffic source, not just its endpoint (Rem, 2026-08-16). */
    private source: string = "untagged",
  ) {}

  private async bearer(): Promise<string> {
    return typeof this.token === "string" ? this.token : await this.token();
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    let rateLimited = 0; // 429s get their own generous budget
    let transient = 0; // network errors / timeouts
    let forbidden = 0; // 403s — retried once (see FORBIDDEN_RETRIES)
    for (;;) {
      // Respect a global cooldown before sending: don't add to a throttle in progress.
      // Both caller classes bail on a LONG window rather than poking through it: the old
      // patient behavior slept its 30s cap and then SENT ANYWAY — one poke per 30s for the
      // whole ban, the opposite of the "one probe per persist interval" the design claims
      // (audit 2026-08-19, T1.10). Patient callers ride out short throttles (≤2 min) by
      // sleeping in capped slices until the window has actually passed.
      for (;;) {
        const cooldown = cooldownUntil - Date.now();
        if (cooldown <= 0) break;
        const capMs = (this.patient ? RETRY_AFTER_CAP_S.patient : RETRY_AFTER_CAP_S.fast) * 1000;
        if (!this.patient && cooldown > capMs) {
          throw new SpotifyError(429, "Spotify is rate-limiting — try again shortly.");
        }
        if (this.patient && cooldown > PATIENT_MAX_COOLDOWN_WAIT_MS) {
          throw new SpotifyError(429, "Spotify is rate-limiting — long cooldown in effect.");
        }
        await sleep(Math.min(cooldown, capMs) + 250);
      }
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await this.bearer()}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          // Fail fast instead of hanging a request (and anything awaiting it).
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) {
        // Log the failed attempt too (network error / timeout), then retry or surface it.
        void logSpotifyRequest({ method, path, status: 0, retryAfter: null, source: this.source }).catch(() => {});
        // Never blind-retry a POST: a timeout doesn't mean Spotify didn't apply it, and
        // POSTs here aren't idempotent (add items again = duplicate tracks; create
        // playlist again = a second playlist; next/previous again = double skip).
        // Player PUTs aren't idempotent either: a re-sent /me/player/play restarts the
        // track from 0, a re-sent seek yanks the head back (audit 2026-08-19, T2.11).
        // Everything else (GET, playlist PUT/DELETE) is safe to re-send.
        const playerMutation = method !== "GET" && path.startsWith("/me/player");
        if (method !== "POST" && !playerMutation && transient++ < MAX_RETRIES) {
          await sleep(transient * 500);
          continue;
        }
        throw e;
      }

      // Record every outgoing call so a 429 can be analysed after the fact. Fire-and-forget
      // (the DB write must never slow a Spotify request).
      // `Number(x) || null` read "Retry-After: 0" as null; 0 is a real (immediate-retry)
      // answer and now passes through. HTTP-date forms still parse to NaN → null ("no
      // answer" → 1s default) — accepted: Spotify sends seconds, and date arithmetic here
      // isn't worth the surface (audit T2.11; wording fixed per wave-3 review, O1).
      // Empty/whitespace headers must read as "no answer" too — Number("") is 0, which the
      // 429 branch would treat as "retry immediately" (wave-2 adversarial review, finding I).
      const retryHeader = res.status === 429 ? res.headers.get("Retry-After") : null;
      const retryParsed =
        retryHeader === null || retryHeader.trim() === "" ? NaN : Number(retryHeader);
      // Negative values are junk, not an answer — they used to zero out both the sleep
      // floor and the shared cooldown (wave-3 independent suite, G).
      const rawRetryAfter = Number.isFinite(retryParsed) && retryParsed >= 0 ? retryParsed : null;
      void logSpotifyRequest({ method, path, status: res.status, retryAfter: rawRetryAfter, source: this.source }).catch(
        () => {},
      );

      // Rate limited: respect Retry-After (capped per-wait) and retry. Interactive
      // callers give up quickly (UI degrades); patient callers ride it out.
      const rlMax = this.patient ? RATE_LIMIT_RETRIES.patient : RATE_LIMIT_RETRIES.fast;
      const rlCap = this.patient ? RETRY_AFTER_CAP_S.patient : RETRY_AFTER_CAP_S.fast;
      if (res.status === 429) {
        const retryAfter = Math.min(rawRetryAfter ?? 1, rlCap);
        // Make every other request back off too, not just this one. The shared window uses
        // Spotify's ACTUAL ask (bounded at 30 min), not the per-wait retry cap — capping the
        // cooldown at 5s for a 60s demand kept traffic flowing into the throttle for the
        // whole 5–120s band (audit 2026-08-19, T2.11).
        const askMs = Math.min((rawRetryAfter ?? 1) * 1000, PERSIST_COOLDOWN_CAP_MS);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + askMs + 250);
        // On the first 429 of this call, log how hard we were hitting Spotify just before
        // it throttled — the data we use to learn where the real limit is.
        if (rateLimited === 0) {
          void getApiLogSummary()
            .then((s) => {
              const w = s.windows.map((x) => `${x.seconds}s=${x.calls}`).join(" ");
              console.warn(
                `[spotify] rate-limited on ${method} ${path} — Spotify Retry-After=${rawRetryAfter ?? "?"}s; recent calls ${w}`,
              );
            })
            .catch(() => {});
        }
        // If Spotify is asking us to wait far longer than we'd ever usefully retry (it
        // hands out multi-hour bans when an endpoint is hammered), stop now: more calls
        // can't succeed in any reasonable window and only risk deepening the ban.
        if ((rawRetryAfter ?? 0) > HARD_BAN_S) {
          // Persist the backoff so other serverless invocations (cron ticks, on-load
          // polls) honor it — module-scoped `cooldownUntil` is wiped between invocations,
          // so without this every tick re-pokes the banned endpoint.
          const untilMs = Date.now() + Math.min((rawRetryAfter ?? 0) * 1000, PERSIST_COOLDOWN_CAP_MS);
          cooldownUntil = Math.max(cooldownUntil, untilMs);
          // AWAITED: this write is the entire cross-invocation mechanism, and a void'd
          // promise right before `return` can be frozen with the invocation on Vercel —
          // the ban then never persists and every tick re-pokes (audit 2026-08-19, T1.10).
          await setSpotifyCooldownUntil(untilMs).catch(() => {});
          console.warn(
            `[spotify] hard ban on ${method} ${path} — Retry-After=${rawRetryAfter}s; persisted cooldown ${Math.round((untilMs - Date.now()) / 60000)}min`,
          );
          return res;
        }
        if (rateLimited < rlMax) {
          rateLimited++;
          await sleep((retryAfter + 0.25) * 1000);
          continue;
        }
        // Out of retries — return the 429; the cooldown above keeps others off Spotify.
      }
      // 403: one quick retry for a transient blip, then give up (a genuine "forbidden",
      // e.g. another user's playlist in dev mode, won't recover and shouldn't burn calls).
      if (res.status === 403 && forbidden < FORBIDDEN_RETRIES) {
        forbidden++;
        await sleep(500);
        continue;
      }
      return res;
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SpotifyError(res.status, text || res.statusText);
    }
    if (res.status === 204) return undefined as T;
    // Player mutations (seek/next/play/pause/queue) can answer 200 with an empty
    // or non-JSON body — an EMPTY body means a bodyless mutation and undefined is right.
    // A NON-EMPTY body that fails to parse is a different animal (an edge error page, a
    // truncated response): silently widening it to undefined surfaced later as a bare
    // TypeError deep in a caller instead of a SpotifyError here (audit 2026-08-19, T2.11).
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SpotifyError(res.status, `non-JSON ${res.status} body from ${method} ${path}`);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.json<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>("POST", path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>("PUT", path, body);
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>("DELETE", path, body);
  }

  /**
   * Follow `next` links to collect every item of a paginated endpoint.
   * `onProgress` reports (collected, total) for long scans (clean playlist).
   */
  async getAll<T>(
    firstPath: string,
    onProgress?: (collected: number, total: number) => void,
  ): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = firstPath;
    let total = 0;
    // Termination was delegated entirely to Spotify's `next` — a self-referencing link
    // would loop forever. 500 pages ≈ 25k items covers any real collection here.
    let pages = 0;
    while (url) {
      if (++pages > 500) throw new SpotifyError(508, `pagination did not terminate: ${firstPath}`);
      const page: Paging<T> = await this.get<Paging<T>>(url);
      if (!page || !Array.isArray(page.items)) {
        throw new SpotifyError(502, `malformed page from ${url}`);
      }
      items.push(...page.items);
      total = page.total || total;
      onProgress?.(items.length, total);
      url = page.next;
    }
    return items;
  }
}
