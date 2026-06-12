// Low-level Spotify HTTP client. The single place that talks to api.spotify.com.
// Owns: auth header, JSON, pagination, 429/Retry-After backoff. No domain logic here.

import type { Paging } from "./types";
import { getApiLogSummary, logSpotifyRequest } from "@/lib/db";

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
      const cooldown = cooldownUntil - Date.now();
      if (cooldown > 0) {
        const capMs = (this.patient ? RETRY_AFTER_CAP_S.patient : RETRY_AFTER_CAP_S.fast) * 1000;
        if (!this.patient && cooldown > capMs) {
          throw new SpotifyError(429, "Spotify is rate-limiting — try again shortly.");
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
        void logSpotifyRequest({ method, path, status: 0, retryAfter: null }).catch(() => {});
        // Never blind-retry a POST: a timeout doesn't mean Spotify didn't apply it, and
        // POSTs here aren't idempotent (add items again = duplicate tracks; create
        // playlist again = a second playlist; next/previous again = double skip).
        // GET/PUT/DELETE are safe to re-send.
        if (method !== "POST" && transient++ < MAX_RETRIES) {
          await sleep(transient * 500);
          continue;
        }
        throw e;
      }

      // Record every outgoing call so a 429 can be analysed after the fact. Fire-and-forget
      // (the DB write must never slow a Spotify request).
      const rawRetryAfter =
        res.status === 429 ? Number(res.headers.get("Retry-After") ?? "") || null : null;
      void logSpotifyRequest({ method, path, status: res.status, retryAfter: rawRetryAfter }).catch(
        () => {},
      );

      // Rate limited: respect Retry-After (capped per-wait) and retry. Interactive
      // callers give up quickly (UI degrades); patient callers ride it out.
      const rlMax = this.patient ? RATE_LIMIT_RETRIES.patient : RATE_LIMIT_RETRIES.fast;
      const rlCap = this.patient ? RETRY_AFTER_CAP_S.patient : RETRY_AFTER_CAP_S.fast;
      if (res.status === 429) {
        const retryAfter = Math.min(rawRetryAfter ?? 1, rlCap);
        // Make every other request back off too, not just this one.
        cooldownUntil = Math.max(cooldownUntil, Date.now() + (retryAfter + 0.25) * 1000);
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
    // or non-JSON body. GETs always return valid JSON, so a parse failure here
    // means a bodyless mutation — return undefined instead of throwing.
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
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
    while (url) {
      const page: Paging<T> = await this.get<Paging<T>>(url);
      items.push(...page.items);
      total = page.total || total;
      onProgress?.(items.length, total);
      url = page.next;
    }
    return items;
  }
}
