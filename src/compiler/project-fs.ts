import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmSync, symlinkSync, lstatSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Skeleton } from "./schema.js";
import { parseSkeletonXML } from "./xml.js";
import { pruneEntryFns } from "./lib-fns.js";
import { bundleAt } from "../layout.js";

/** Compiler filesystem plumbing: skeleton loading, ESM package + reharness symlink, and orphan cleanup.
 *  Kept separate from codegen.ts (pure string emission) so each file has one responsibility. */

// reharness package root — this file lives at <root>/dist/compiler/project-fs.js → root is two levels up.
const REHARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Parse every `<skeletonsDir>/*.xml` into a Skeleton, skipping unparseable files. The single source of the
 *  read+filter+parse pattern; callers that must SURFACE parse errors (verify, evolve's validator) keep their
 *  own per-file loop instead. */
export function loadSkeletons(skeletonsDir: string): Skeleton[] {
  if (!existsSync(skeletonsDir)) return [];
  const out: Skeleton[] = [];
  for (const f of readdirSync(skeletonsDir).filter(f => f.endsWith(".xml"))) {
    try { out.push(parseSkeletonXML(readFileSync(resolve(skeletonsDir, f), "utf-8"))); }
    catch { /* unparseable — skip */ }
  }
  return out;
}

/** Command ids in the workspace (one skeleton = one command). The de-facto "list commands" operation. */
export function loadSkeletonIds(skeletonsDir: string): string[] {
  return loadSkeletons(skeletonsDir).map(s => s.id);
}

/** An agent leaf, addressed by its name and owning command — the unit enhance/evolve fan out over. */
export interface LeafRef { name: string; skeletonId: string }

/** Every agent leaf in the workspace, optionally scoped to one command (`command` empty ⇒ all commands). */
export function agentLeaves(skeletonsDir: string, command = ""): LeafRef[] {
  const out: LeafRef[] = [];
  for (const sk of loadSkeletons(skeletonsDir)) {
    if (command && sk.id !== command) continue;
    for (const [name, s] of Object.entries(sk.states)) if (s.type === "agent") out.push({ name, skeletonId: sk.id });
  }
  return out;
}

/** Read + parse a JSON file, returning `fallback` if it's absent or unparseable. The single owner of the
 *  "best-effort read-or-default" idiom that the harness/ledger/verdict reads all share. */
export function readJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
  catch { return fallback; }
}

/** A command's PRIVATE agent directory — `<reharnessDir>/agents/<cmdId>/`. Agents are namespaced per command
 *  (module visibility: private by default), so two commands' same-named agent states never collide. The runtime
 *  resolves a generated command's agents from this scoped dir (the command bakes `resolve(ctx.agents, '<id>')`). */
export function commandAgentsDir(reharnessDir: string, cmdId: string): string {
  return resolve(bundleAt(reharnessDir).agents, cmdId);
}

/** Ensure the bundle is an ESM package, can resolve `import ... from 'reharness'`, and gitignores its run-exhaust.
 *  `projectRoot` here is the BUNDLE root (the deliverable) — self-contained so it stays runnable when lifted out. */
/** reharness's own version — pinned into a bundle's package.json so a lifted bundle is `npm install`-able on any
 *  machine (`^0.1.0` = 0.1.x under npm's 0.x rules: patches yes, a potentially-breaking minor no). */
const REHARNESS_DEP = (() => {
  try { const v = JSON.parse(readFileSync(resolve(REHARNESS_ROOT, "package.json"), "utf-8")).version; return v ? `^${v}` : "*"; }
  catch { return "*"; }
})();

export function ensureESMPackage(projectRoot: string, fallbackName: string): void {
  // gitignore the regenerable bits so the bundle versions clean (the deliverable) without its run-exhaust / link.
  const giPath = resolve(projectRoot, ".gitignore");
  if (!existsSync(giPath)) { mkdirSync(projectRoot, { recursive: true }); writeFileSync(giPath, ".cache/\nnode_modules/\n"); }
  const pkgPath = resolve(projectRoot, "package.json");
  // A bundle is a real npm package that depends on reharness — so `mv` it elsewhere, run `npm install`, and the
  // generated commands' `import 'reharness'` resolves WITHOUT the dev-machine symlink. (Locally the symlink below
  // satisfies it without an install; a real `npm install` later just overwrites the link with the published package.)
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: fallbackName, private: true, type: "module", dependencies: { reharness: REHARNESS_DEP } }, null, 2) + "\n");
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      let changed = false;
      if (!pkg.type) { pkg.type = "module"; changed = true; }
      if (!pkg.dependencies?.reharness) { pkg.dependencies = { ...pkg.dependencies, reharness: REHARNESS_DEP }; changed = true; }
      if (changed) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    } catch { /* corrupt — leave alone */ }
  }
  ensureReharnessLink(projectRoot);
}

/** Generated commands `import { defineCommand, definePipeline } from 'reharness'` — make sure that
 *  resolves by symlinking the current reharness install into `<projectRoot>/node_modules/reharness`. */
function ensureReharnessLink(projectRoot: string): void {
  const nodeModules = resolve(projectRoot, "node_modules");
  const link = resolve(nodeModules, "reharness");
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink()) {
      // isSymbolicLink() is true even for a DANGLING symlink (it checks the entry type, not the target).
      // existsSync follows the link, so it's true only when the target actually resolves.
      if (existsSync(link)) return;   // working symlink — done
      unlinkSync(link);                // broken (target deleted) — remove and recreate below
    } else if (st.isDirectory()) {
      return;                          // real directory (e.g. real npm install) — don't touch it
    }
  } catch { /* missing — fall through and create */ }
  mkdirSync(nodeModules, { recursive: true });
  try {
    symlinkSync(REHARNESS_ROOT, link, "dir");
  } catch (err: any) {
    // EEXIST race or symlink unavailable — non-fatal, verify will surface the real problem.
    if (err.code !== "EEXIST") {
      console.error(`⚠ ensureReharnessLink: ${err.message}`);
    }
  }
}

/** Remove agent dirs and lib *Entry functions whose state (or whole command) was removed from the skeletons. */
export function reconcile(reharnessDir: string): void {
  const L = bundleAt(reharnessDir);
  const skeletonsDir = L.skeletons;
  // A command is "live" iff its skeleton FILE exists on disk — the source of truth. This is deliberately decoupled
  // from parse/codegen success: a command whose codegen just failed, or whose skeleton is present-but-unparseable,
  // keeps its artifacts. Only a DELETED skeleton is an orphan. (Conflating a transient failure with a deletion would
  // silently wipe hand-filled prompts/lib — recoverable only from VCS.)
  const liveIds = existsSync(skeletonsDir)
    ? new Set(readdirSync(skeletonsDir).filter(f => f.endsWith(".xml")).map(f => f.slice(0, -4)))
    : new Set<string>();
  const skeletons = loadSkeletons(skeletonsDir); // parsed — drives the finer within-command pruning below
  const agentsByCmd = new Map<string, Set<string>>();
  const codeStatesById = new Map<string, Set<string>>();
  for (const sk of skeletons) {
    const code = new Set<string>(), agents = new Set<string>();
    for (const [name, s] of Object.entries(sk.states)) {
      if (s.type === "agent" || s.type === "interactive") agents.add(name);
      if (s.type === "code") code.add(name);
    }
    agentsByCmd.set(sk.id, agents);
    codeStatesById.set(sk.id, code);
  }

  // Agents are namespaced per command: agents/<cmdId>/<name>/. Drop orphan command dirs whole (no skeleton file),
  // and within a live+parsed command drop agent dirs no longer in its skeleton. (Flat agents/<name>/ from the old
  // layout become orphans.) A live-but-unparseable command is left intact — we don't prune against a skeleton we
  // couldn't read.
  const agentsRoot = L.agents;
  if (existsSync(agentsRoot)) {
    for (const cmd of readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!cmd.isDirectory()) continue;
      const cmdPath = resolve(agentsRoot, cmd.name);
      if (!liveIds.has(cmd.name)) { rmSync(cmdPath, { recursive: true, force: true }); continue; }
      const live = agentsByCmd.get(cmd.name);
      if (!live) continue;
      for (const a of readdirSync(cmdPath, { withFileTypes: true })) {
        if (a.isDirectory() && !live.has(a.name)) rmSync(resolve(cmdPath, a.name), { recursive: true, force: true });
      }
    }
  }

  const libDir = L.lib;
  if (!existsSync(libDir)) return;
  for (const [id, code] of codeStatesById) {
    const path = resolve(libDir, `${id}-states.ts`);
    if (!existsSync(path)) continue;
    const cleaned = pruneEntryFns(readFileSync(path, "utf-8"), code);
    if (cleaned !== null) writeFileSync(path, cleaned);
  }
}
