// Low-level Spotify HTTP client. The single place that talks to api.spotify.com.
// Owns: auth header, JSON, pagination, 429/Retry-After backoff. No domain logic here.

import type { Paging } from "./types";

const BASE = "https://api.spotify.com/v1";
const MAX_RETRIES = 3;
// 429 handling depends on who's calling. Interactive paths (opening a playlist,
// saving the queue, now-playing) must FAIL FAST and let the UI degrade — never
// hang for minutes. Background bulk work (cleaning a playlist scans the whole
// library) opts into "patient" mode to ride out throttling and finish. Per-wait
// caps bound how long any single wait can be.
const RATE_LIMIT_RETRIES = { fast: 3, patient: 12 };
const RETRY_AFTER_CAP_S = { fast: 5, patient: 30 };

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

export class HttpClient {
  // `patient` = ride out rate limits (background bulk work). Default false so
  // interactive callers fail fast.
  constructor(
    private accessToken: string,
    private patient = false,
  ) {}

  private async raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    let rateLimited = 0; // 429s get their own generous budget
    let transient = 0; // 403/timeout get a smaller one
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
            Authorization: `Bearer ${this.accessToken}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          // Fail fast instead of hanging a request (and anything awaiting it).
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) {
        // Network error / timeout: retry a couple of times, then surface it.
        if (transient++ < MAX_RETRIES) {
          await sleep(transient * 500);
          continue;
        }
        throw e;
      }

      // Rate limited: respect Retry-After (capped per-wait) and retry. Interactive
      // callers give up quickly (UI degrades); patient callers ride it out.
      const rlMax = this.patient ? RATE_LIMIT_RETRIES.patient : RATE_LIMIT_RETRIES.fast;
      const rlCap = this.patient ? RETRY_AFTER_CAP_S.patient : RETRY_AFTER_CAP_S.fast;
      if (res.status === 429) {
        const retryAfter = Math.min(Number(res.headers.get("Retry-After") ?? "1"), rlCap);
        // Make every other request back off too, not just this one.
        cooldownUntil = Math.max(cooldownUntil, Date.now() + (retryAfter + 0.25) * 1000);
        if (rateLimited < rlMax) {
          rateLimited++;
          await sleep((retryAfter + 0.25) * 1000);
          continue;
        }
        // Out of retries — return the 429; the cooldown above keeps others off Spotify.
      }
      // Spotify also returns 403 transiently under burst load (not just true
      // "forbidden"). Retry a few times with backoff before giving up, so a
      // single throttled request doesn't crash the page.
      if (res.status === 403 && transient < MAX_RETRIES) {
        transient++;
        await sleep(transient * 500);
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
