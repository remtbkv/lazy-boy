// Low-level Spotify HTTP client. The single place that talks to api.spotify.com.
// Owns: auth header, JSON, pagination, 429/Retry-After backoff. No domain logic here.

import type { Paging } from "./types";

const BASE = "https://api.spotify.com/v1";
const MAX_RETRIES = 3;

export class SpotifyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SpotifyError";
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  constructor(private accessToken: string) {}

  private async raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });

      // Rate limited: respect Retry-After, then retry.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        await sleep((retryAfter + 0.25) * 1000);
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
    return (await res.json()) as T;
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
