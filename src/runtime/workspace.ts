import { mkdirSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import type { StateDefinition } from "./types.js";
import { isParallel, isLoop } from "./state-guards.js";

// ── Instance-vector workspace addressing (the polyhedral iteration-space model) ──
// Every stage execution is identified by its INSTANCE VECTOR: one index per enclosing composite (a parallel's
// branch index / a loop's iteration), outermost-first. Its output dir is <workRoot>/<stage>/<i0>/…. Producer-
// write, recorded dir, and consumer-read all derive from (stage, instance vector) → no drift.

export interface Workspace {
  /** This stage's own instance dir at `path` (created). Backs `c.out`. */
  instDir(stage: string, path: number[]): string;
  /** A single upstream producer's instance visible to a consumer at `path` (producer's enclosing composites
   *  all enclose the consumer; loop-carried-aware fallback to the latest sibling ≤ the current index). */
  singleDir(producer: string, path: number[]): string;
  /** The collection of a producer's instances over the axes the consumer `from` has EXITED — one dir per
   *  branch (exited parallel = map) and/or per iteration (exited loop = scan/history). */
  collectionDirs(producer: string, from: string, path: number[]): string[];
}

export function makeWorkspace<C extends Record<string, any>>(
  workRoot: string,
  states: Record<string, StateDefinition<C>>,
): Workspace {
  // Enclosing-composite chain per state (mirrors the compiler's enclosingScope, computed from the states).
  const scope = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const [n, s] of Object.entries(states)) {
    if (isParallel(s)) parent.set(s.branch, n);
    if (isLoop(s)) for (const step of s.steps) parent.set(step, n);
  }
  for (const n of Object.keys(states)) {
    const chain: string[] = [];
    for (let cur = n; parent.has(cur); ) { const p = parent.get(cur)!; chain.unshift(p); cur = p; }
    scope.set(n, chain);
  }
  const commonPrefix = (a: string[], b: string[]): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

  const instDir = (stage: string, path: number[]): string => {
    const d = resolve(workRoot, stage, ...path.map(String));
    mkdirSync(d, { recursive: true });
    return d;
  };

  const singleDir = (producer: string, path: number[]): string => {
    const idx = path.slice(0, (scope.get(producer) ?? []).length);
    let d = resolve(workRoot, producer, ...idx.map(String));
    if (!existsSync(d) && idx.length) {
      const parentDir = resolve(workRoot, producer, ...idx.slice(0, -1).map(String));
      const cur = idx[idx.length - 1];
      const sib = existsSync(parentDir)
        ? readdirSync(parentDir).filter(f => /^\d+$/.test(f)).map(Number).filter(x => x <= cur).sort((a, b) => b - a)[0]
        : undefined;
      if (sib !== undefined) d = resolve(parentDir, String(sib));
    }
    mkdirSync(d, { recursive: true });
    return d;
  };

  const collectionDirs = (producer: string, from: string, path: number[]): string[] => {
    const sP = scope.get(producer) ?? [];
    const shared = commonPrefix(scope.get(from) ?? [], sP);
    let dirs = [resolve(workRoot, producer, ...path.slice(0, shared).map(String))];
    for (let lvl = shared; lvl < sP.length; lvl++) {
      const next: string[] = [];
      for (const d of dirs) if (existsSync(d)) for (const f of readdirSync(d).filter(x => /^\d+$/.test(x)).sort((a, b) => +a - +b)) next.push(resolve(d, f));
      dirs = next;
    }
    return dirs;
  };

  return { instDir, singleDir, collectionDirs };
}
