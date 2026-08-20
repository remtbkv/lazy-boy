// next/cache stub for the simulation: unstable_cache becomes a passthrough, so every
// "cached" read actually executes — which is what a correctness test wants (the real
// cache's keying discipline is audited separately; here we test the reads themselves).
export function unstable_cache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  _keys?: string[],
  _opts?: unknown,
): (...args: A) => Promise<R> {
  return (...args: A) => fn(...args);
}

export function revalidatePath(): void {}
export function revalidateTag(): void {}
