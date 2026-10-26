// The dock's motion (den.css, "The dock's motion"; lane 0598, 2026-10-26). Home's action dock
// animates transform and opacity only, on one duration and one easing. This fails on anything
// else that animates in the dock's markup (dock.tsx, clean-progress.tsx: Tailwind transition,
// animate, duration and ease utilities, inline transition/animation styles) or in den.css's
// rules for the dock's classes (.dock-*: transition lists, @starting-style, keyframes they run).
// The old dock failed it: background/border/color transitions on its pills, rows and badges,
// and six durations (DOCK_MOTION_ROOT=<a checkout of f2c8937> shows the list).
// Plus known answers for lib/dock-motion.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { exitDone, originFrom } from "@/lib/dock-motion";

const ROOT = process.env.DOCK_MOTION_ROOT ?? path.resolve(__dirname, "..");
const MARKUP = ["src/app/(app)/home/dock.tsx", "src/components/clean-progress.tsx"];
const CSS = "src/app/(app)/den.css";

const MOTION = new Set(["transform", "opacity", "translate", "scale", "rotate"]);
// Tailwind's animate-* utilities whose keyframes move transform/opacity only (the clean pill's
// spinner is animate-spin).
const ANIMATE_OK = new Set(["animate-spin", "animate-ping", "animate-pulse", "animate-bounce", "animate-none"]);
const DUR = "var(--dock-dur)";
const EASE = "var(--dock-ease)";

/** Faults in one file's markup: every string literal and template part is read as class tokens. */
export function markupFaults(src: string, file: string): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const toks = n.text.split(/\s+/).filter(Boolean);
      // strip variants (hover:, sm:, disabled:, motion-safe:, [&_x]:) and the important flag
      const bare = toks.map((t) => t.replace(/^(?:[\w-]+:|\[[^\]]*\]:)*!?/, ""));
      const animates = bare.filter((t) => /^transition-(opacity|transform)$/.test(t));
      for (const t of bare) {
        if (t === "transition" || /^transition-(all|colors|shadow)$/.test(t)) out.push(`${at(n)} ${t}`);
        else if (/^transition-\[/.test(t)) {
          const props = t.slice("transition-[".length, -1).split(",");
          if (props.some((p) => !MOTION.has(p))) out.push(`${at(n)} ${t}`);
        } else if (/^animate-/.test(t) && !ANIMATE_OK.has(t)) out.push(`${at(n)} ${t}`);
        else if (/^\[(transition|animation)[\w-]*:/.test(t)) out.push(`${at(n)} ${t}`);
        else if (/^(duration|ease|delay)-/.test(t) && t !== "duration-(--dock-dur)" && t !== "ease-(--dock-ease)") out.push(`${at(n)} ${t} (the dock's timing is --dock-dur / --dock-ease)`);
      }
      if (animates.length && !(bare.includes("duration-(--dock-dur)") && bare.includes("ease-(--dock-ease)"))) {
        out.push(`${at(n)} ${animates.join(" ")} without duration-(--dock-dur) ease-(--dock-ease)`);
      }
    }
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && /^(transition|animation)/i.test(n.name.getText(sf).replace(/["']/g, ""))) {
      out.push(`${at(n)} inline style ${n.name.getText(sf)} (dock motion lives in den.css)`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Rule = { prelude: string; decls: [string, string][]; children: Rule[] };

function parseCss(src: string): Rule[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const decl = (buf: string): [string, string] | null => {
    const k = buf.indexOf(":");
    return k > 0 ? [buf.slice(0, k).trim(), buf.slice(k + 1).trim()] : null;
  };
  const block = (): Omit<Rule, "prelude"> => {
    const decls: [string, string][] = [];
    const children: Rule[] = [];
    let buf = "";
    while (i < s.length) {
      const c = s[i++];
      if (c === "{") {
        const prelude = buf.trim();
        buf = "";
        children.push({ prelude, ...block() });
      } else if (c === "}" || c === ";") {
        const d = buf.trim() ? decl(buf) : null;
        if (d) decls.push(d);
        buf = "";
        if (c === "}") break;
      } else buf += c;
    }
    return { decls, children };
  };
  return block().children;
}

/** Split a comma list at the top level (not inside parentheses). */
function items(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of v) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Faults in den.css's rules for the dock's classes. */
export function cssFaults(src: string): string[] {
  const out: string[] = [];
  const rules = parseCss(src);
  const keyframes = new Map<string, Set<string>>();
  const collect = (rs: Rule[]) => {
    for (const r of rs) {
      const m = r.prelude.match(/^@keyframes\s+([\w-]+)/);
      if (m) keyframes.set(m[1], new Set(r.children.flatMap((f) => f.decls.map(([k]) => k))));
      else collect(r.children);
    }
  };
  collect(rules);
  const walk = (rs: Rule[], starting: boolean) => {
    for (const r of rs) {
      if (r.prelude.startsWith("@keyframes")) continue;
      if (r.prelude.startsWith("@")) {
        walk(r.children, starting || r.prelude.startsWith("@starting-style"));
        continue;
      }
      if (r.prelude.includes(".dock-")) {
        const where = `den.css ${r.prelude.replace(/\s+/g, " ")}`;
        for (const [k, v] of r.decls) {
          if (starting && !MOTION.has(k)) out.push(`${where}: @starting-style sets ${k}`);
          if (k === "transition") {
            for (const it of items(v)) {
              const prop = it.split(/\s+/)[0];
              if (it === "none") continue;
              if (!MOTION.has(prop)) out.push(`${where}: transition of ${prop}`);
              if (!it.includes(DUR) || !it.includes(EASE)) out.push(`${where}: "${it}" is not ${DUR} ${EASE}`);
            }
          } else if (k === "transition-property") {
            for (const prop of items(v)) if (!MOTION.has(prop) && prop !== "none") out.push(`${where}: transition of ${prop}`);
          } else if (k === "transition-duration" && v !== DUR) out.push(`${where}: transition-duration ${v}`);
          else if (k === "transition-timing-function" && v !== EASE) out.push(`${where}: transition-timing-function ${v}`);
          else if (k === "animation" || k === "animation-name") {
            for (const it of items(v)) {
              const name = it.split(/\s+/).find((w) => keyframes.has(w));
              const props = name ? [...keyframes.get(name)!] : [];
              if (!name) out.push(`${where}: animation "${it}" names no keyframes in den.css`);
              for (const p of props) if (!MOTION.has(p)) out.push(`${where}: @keyframes ${name} animates ${p}`);
              if (k === "animation" && (!it.includes(DUR) || !it.includes(EASE))) out.push(`${where}: "${it}" is not ${DUR} ${EASE}`);
            }
          }
        }
      }
      walk(r.children, starting);
    }
  };
  walk(rules, false);
  return out;
}

describe("the dock animates transform and opacity only, on one duration and easing", () => {
  it("in its markup", () => {
    const faults = MARKUP.flatMap((f) => markupFaults(readFileSync(path.join(ROOT, f), "utf8"), f));
    expect(faults).toEqual([]);
  });

  it("in den.css", () => {
    const css = readFileSync(path.join(ROOT, CSS), "utf8");
    expect(cssFaults(css)).toEqual([]);
    // and the dock's motion is actually there to check
    expect(css).toMatch(/\.dock-surface\s*\{[^}]*transition:/);
    expect(css).toMatch(/--dock-dur:\s*\d+ms/);
  });

  it("catches what it is for (planted)", () => {
    const tsx = `export const A = () => <div className={cn("dock-surface transition-colors", x && "hover:transition-[height]")} style={{ transition: "top 1s" }}><b className="transition-opacity duration-300 animate-in" /></div>;`;
    expect(markupFaults(tsx, "plant.tsx")).toEqual([
      "plant.tsx:1 transition-colors",
      "plant.tsx:1 transition-[height]",
      "plant.tsx:1 inline style transition (dock motion lives in den.css)",
      "plant.tsx:1 duration-300 (the dock's timing is --dock-dur / --dock-ease)",
      "plant.tsx:1 animate-in",
      "plant.tsx:1 transition-opacity without duration-(--dock-dur) ease-(--dock-ease)",
    ]);
    const css = `
      @keyframes drop { from { top: 0; opacity: 0 } to { top: 10px; opacity: 1 } }
      .dock-surface { transition: opacity var(--dock-dur) var(--dock-ease), height 200ms ease; }
      @media (prefers-reduced-motion: no-preference) { .dock-scrim { animation: drop var(--dock-dur) var(--dock-ease); } }
      @starting-style { .dock-fade { opacity: 0; margin-top: 8px; } }
      .elsewhere { transition: height 1s; }`;
    expect(cssFaults(css)).toEqual([
      "den.css .dock-surface: transition of height",
      `den.css .dock-surface: "height 200ms ease" is not ${DUR} ${EASE}`,
      "den.css .dock-scrim: @keyframes drop animates top",
      "den.css .dock-fade: @starting-style sets margin-top",
    ]);
  });
});

describe("lib/dock-motion", () => {
  // A stand-in for an element chain: offsetLeft/Top relative to offsetParent, as the browser gives.
  const el = (offsetLeft: number, offsetTop: number, offsetParent: unknown = null) =>
    ({ offsetLeft, offsetTop, offsetParent }) as unknown as HTMLElement;

  it("originFrom: the pressed control's centre in the surface's own box", () => {
    // a desktop sheet at (736, 162) inside a fixed layer at (0, 0); Clean's pill centre (560, 200)
    expect(originFrom({ x: 560, y: 200 }, el(736, 162, el(0, 0)))).toBe("-176px 38px");
    // a phone sheet at the bottom (0, 260); the pill above it at (180.4, 90.6)
    expect(originFrom({ x: 180.4, y: 90.6 }, el(0, 260))).toBe("180px -169px");
    expect(originFrom(null, el(10, 10))).toBe("50% 0%");
  });

  it("exitDone waits for every transition on every element, and resolves at once with none", async () => {
    let finish!: () => void;
    let cancel!: (e: Error) => void;
    const a = new Promise<void>((r) => (finish = r));
    const b = new Promise<void>((_, j) => (cancel = j));
    const surf = { getAnimations: () => [{ finished: a }] } as unknown as Element;
    const scrim = { getAnimations: () => [{ finished: b }] } as unknown as Element;
    let done = false;
    const p = exitDone(surf, scrim, null).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false); // the scrim is still going
    cancel(new Error("AbortError")); // a cancelled exit (element removed) still ends the wait
    await p;
    expect(done).toBe(true);
    await expect(exitDone(null)).resolves.toBeUndefined();
  });
});
