// The request the authz suite is "inside" (docs/multi-user/AUTHZ.md). next/headers' headers()
// and cookies() and next/server's after() read and write this one object, so a test sets a
// principal's cookie and headers here and then calls a route handler, a server action or a page
// directly, with the real Auth.js decoding the real cookie.
//
// Each authz test file mocks the two modules with these factories:
//   vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
//   vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));

export const ctx = {
  headers: {} as Record<string, string>,
  cookies: new Map<string, string>(),
  after: [] as Promise<unknown>[],
};

export function resetContext(): void {
  ctx.headers = {};
  ctx.cookies = new Map();
  ctx.after = [];
}

/** The request's headers as a route handler or Auth.js sees them, cookie header included. */
export function requestHeaders(): Headers {
  const h = new Headers({ host: "127.0.0.1:3000", "x-forwarded-proto": "http", ...ctx.headers });
  const jar = [...ctx.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (jar) h.set("cookie", jar);
  return h;
}

function cookieStore() {
  const entry = (name: string) => {
    const value = ctx.cookies.get(name);
    return value === undefined ? undefined : { name, value };
  };
  return {
    get: (name: string | { name: string }) => entry(typeof name === "string" ? name : name.name),
    getAll: () => [...ctx.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => ctx.cookies.has(name),
    set: (...args: unknown[]) => {
      const [a, b, c] = args as [string | { name: string; value: string; maxAge?: number }, string?, { maxAge?: number }?];
      const name = typeof a === "string" ? a : a.name;
      const value = typeof a === "string" ? (b ?? "") : a.value;
      const maxAge = typeof a === "string" ? c?.maxAge : a.maxAge;
      if (maxAge === 0 || value === "") ctx.cookies.delete(name);
      else ctx.cookies.set(name, value);
    },
    delete: (name: string | { name: string }) => {
      ctx.cookies.delete(typeof name === "string" ? name : name.name);
    },
    toString: () => requestHeaders().get("cookie") ?? "",
  };
}

export function nextHeadersMock() {
  return {
    headers: async () => requestHeaders(),
    cookies: async () => cookieStore(),
    draftMode: async () => ({ isEnabled: false }),
  };
}

export function nextServerMock(orig: Record<string, unknown>) {
  return {
    ...orig,
    // after() outside a real request has no work-unit store; run it and let the test await it.
    after: (task: (() => unknown) | Promise<unknown>) => {
      const p = Promise.resolve()
        .then(() => (typeof task === "function" ? task() : task))
        .catch(() => {});
      ctx.after.push(p);
    },
  };
}

export async function flushAfter(): Promise<void> {
  while (ctx.after.length) await Promise.all(ctx.after.splice(0));
}
