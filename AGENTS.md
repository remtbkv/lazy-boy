<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — roles & Next 16 quick reference

This file gives an AI agent (1) the personas to adopt when working on this repo and (2) the
Next.js 16 API deltas it must respect. Project overview is in `CLAUDE.md`; deep docs in `docs/`.

## How to work here (token-efficient loop)

1. Read `CLAUDE.md` + the relevant `docs/*.md`. Don't re-derive what's already written.
2. For Spotify behavior, read `docs/FEATURES.md` (algorithms) before touching `src/lib/spotify/`.
3. Implement the smallest change that satisfies the task. Keep domain logic pure.
4. `npm run build` + `npm run lint` must pass before you call something done.
5. Update `docs/ROADMAP.md` status when you finish a backlog item.

## Roles to adopt

Switch persona to match the task. Each persona has a different bar.

**Architect** — when adding a feature area or changing structure. Decide where code lives,
keep the service-layer / pure-domain / task-registry boundaries intact, and write the seam
before the implementation. Output: a short plan + file list, then build.

**Implementer** — the default. Write minimal, idiomatic Next 16 + TypeScript. Match existing
style. No speculative abstraction. Every Spotify call through `src/lib/spotify/`.

**Reviewer** — before declaring done. Check: does each changed line trace to the task? Is the
access token ever exposed client-side? Are paginated calls actually paginated? Is 429 handled?
Are `params`/`cookies()` awaited (Next 16)? Does the build pass?

**Designer** — when touching UI. Stay on the dark Spotify palette (`docs/CONVENTIONS.md`),
reuse shadcn primitives, keep it light and uncluttered. No new color tokens without reason.

## Next.js 16 deltas (must heed)

- `params`, `searchParams` are **Promises**: `const { id } = await params`.
- `cookies()`, `headers()` are **async**: `const c = await cookies()`.
- Route handler signature: `export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> })`.
- `fetch` is **not cached by default**. We don't enable Cache Components; data is fetched fresh per request.
- Middleware → **Proxy** (`src/proxy.ts`). We don't use it — auth gating is server-side in the `(app)` layout. Host canonicalization (`localhost` → `127.0.0.1`) is client-side via an inline script in the root layout (a server redirect loops — Next normalizes the two hosts to one origin).
- Server Actions: `'use server'`, revalidate with `revalidatePath`/`revalidateTag` from `next/cache`.
- Generated route types available: `PageProps<'/route'>`, `LayoutProps<'/route'>` from `next`.
