// The fetch every store query rides (db.ts hands it to createClient). Plain `fetch` is wrong
// here for two independent reasons, both measured against the live store on 2026-08-22.
//
// 1. ACCEPT-ENCODING. Node's fetch advertises brotli, and the funnel in front of sqld honours
//    it — so the ZENBOOK brotli-compresses every response, and the cost scales with the body.
//    Interleaved A/B/A/B against the primary, median of n=5 (min..max):
//
//      query                        default (br)            gzip              identity
//      history payload plays scan   26,436ms [25.9-28.1s]   648ms [508-737]   470ms [406-730]
//      library payload member scan   8,479ms [6.5-8.6s]     367ms [223-492]   188ms [169-274]
//      one-key meta read                58ms [37-76]         26ms [23-31]      24ms [19-26]
//
//    Same rows, same SQL: the whole difference is compression CPU on a laptop. gzip rather
//    than identity because the body still crosses the public internet to Vercel, and the
//    ~1.5s that br "saves" on transfer is not worth 26 seconds of Zenbook CPU.
//
//    This is what broke /api/search/history in production: 26s > the 15s per-attempt timeout
//    below, so the payload the browser searches against never arrived — and Home then rendered
//    a library-only index in which every song and artist reads "Never played" (Rem's
//    screenshots, 2026-08-22).
//
// 2. Retries that actually retry. hrana calls `fetch(request)` with a Request object whose
//    body is a one-shot stream, so re-issuing the SAME object throws
//    "TypeError: Response body object should not be disturbed or locked" (undici's extractBody,
//    via Next's fetch patch) instead of retrying. That made the DNS-blip ladder this wrapper
//    exists for unreachable for every store query — they are all POSTs. The body is buffered
//    once here and each attempt gets a FRESH Request built from it.
const ATTEMPT_TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Build the store fetch. `doFetch` is injected so the retry ladder can be tested without a
 *  network (tests/store-fetch.test.ts); production passes nothing and gets global fetch. */
export function makeStoreFetch(doFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    // Normalize once: after this, `send()` can be called as many times as the ladder needs.
    const req = new Request(input as RequestInfo, init);
    const headers = new Headers(req.headers);
    headers.set("accept-encoding", "gzip");
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

    // A FRESH signal per attempt, not one shared deadline: a single pre-loop
    // AbortSignal.timeout started counting at creation, so a slow first attempt exhausted it
    // and attempts 2-3 rejected instantly, making the gateway-retry ladder unreachable
    // (wave-3 adversarial review, M1). Every other outbound fetch in the repo carries a
    // timeout; this one carries EVERY store query — a funnel that accepts and stalls used to
    // hang the render to the platform timeout. Caller-supplied signals win.
    const send = () =>
      doFetch(req.url, {
        method: req.method,
        headers,
        body,
        redirect: req.redirect,
        signal: init?.signal ?? AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });

    // Some Vercel invocations intermittently fail to RESOLVE the funnel hostname
    // (`getaddrinfo ENOTFOUND ubuntu.tail026729.ts.net` — RSC digest 3227098399, Rem's
    // "refresh crashes, second refresh is fine", 2026-08-16): a resolver blip, not a store
    // outage, and the very next attempt typically succeeds. So a network-level failure (fetch
    // rejects — DNS, reset; NOT an HTTP error response) retries twice with a short pause
    // before it is allowed to surface. Bounded: worst case adds ~750ms to a request that was
    // about to crash the render.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await send();
        // Gateway-class failures (502/503/504) come from the funnel edge, not sqld — the
        // request almost certainly never executed, so a retry is safe even for writes.
        // A 500 is sqld itself and is NOT retried: it may have executed.
        if (
          attempt < ATTEMPTS - 1 &&
          (res.status === 502 || res.status === 503 || res.status === 504)
        ) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        return res;
      } catch (e) {
        if (attempt >= ATTEMPTS - 1) throw e;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  };
}
