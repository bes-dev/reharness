import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Per-stage execution traces live under `<run>/trace/<stage>/<i…>/NN-stage.md`, mirroring the artifact tree
 * `<run>/work/<stage>/<i…>/` (the polyhedral instance vector). ONE addressing scheme — keyed by the stage name
 * for both sequential and parallel/loop instances — so a stage's trace and its outputs share the same path, and
 * there is no separate `parallel/<container>/` or flat top-level scheme. This module is the single owner of that
 * layout: the runtime writes under TRACE_DIR, evolve reads via these helpers.
 */
export const TRACE_DIR = "trace";

/** Every `.md` trace anywhere under a run's trace tree (recursive), concatenated. */
export function collectTraces(runDir: string): string {
  let out = "";
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) { try { out += readFileSync(p, "utf-8") + "\n"; } catch { /* skip */ } }
    }
  };
  walk(resolve(runDir, TRACE_DIR));
  return out;
}

/** Path to an agent leaf's trace file — its stage dir is `trace/<leaf>/…` (any instance) — or null if it did
 *  not run. Works uniformly for sequential and parallel/loop leaves. */
export function findLeafTrace(runDir: string, leaf: string): string | null {
  let hit: string | null = null;
  const walk = (d: string): void => {
    if (hit || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(`-${leaf}.md`)) { hit = p; return; }
    }
  };
  walk(resolve(runDir, TRACE_DIR, leaf));
  return hit;
}
