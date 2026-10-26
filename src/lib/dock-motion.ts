// The motion of Home's action dock (den.css, "The dock's motion"): where a surface grows from,
// and when its exit has finished.

export type Point = { x: number; y: number };

/** The centre of the control that was pressed, in viewport coordinates. */
export function pointOf(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** `from` as a transform-origin in `el`'s own box, so the surface scales out of (and back into)
 *  the control that opened it. Read from the layout box (the offset chain), not the bounding
 *  rect: on mount the rect is already scaled by the entry's starting style. Every dock surface
 *  sits in a position:fixed layer, so the chain ends in viewport coordinates, like `from`. */
export function originFrom(from: Point | null, el: HTMLElement): string {
  if (!from) return "50% 0%";
  let x = 0;
  let y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return `${Math.round(from.x - x)}px ${Math.round(from.y - y)}px`;
}

/** Resolves when the transitions its leaving class started have played out on every element
 *  given. An exit ends on its own transitions, never on a timer: the old timers counted from the
 *  click, so a long frame at that moment (the page refresh a revalidating action triggers) let
 *  them fire before the exit had played, and the sheet was removed mid-exit, still visible (lane
 *  0598's recordings, 2026-10-26). getAnimations() flushes style, so it sees transitions the
 *  class change has just started; with nothing to play it resolves at once. */
export function exitDone(...els: (Element | null)[]): Promise<void> {
  const anims = els.flatMap((el) => (el ? el.getAnimations() : []));
  return Promise.allSettled(anims.map((a) => a.finished)).then(() => undefined);
}
