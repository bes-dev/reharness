import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, symlinkSync, lstatSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Skeleton } from "./schema.js";

/** Filesystem/project plumbing for codegen output: ESM package + reharness symlink, and orphan cleanup.
 *  Kept separate from codegen.ts (pure string emission) so each file has one responsibility. */

// reharness package root — this file lives at <root>/dist/compiler/project-fs.js → root is two levels up.
const REHARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Ensure the target project is an ESM package and can resolve `import ... from 'reharness'`. */
export function ensureESMPackage(projectRoot: string, fallbackName: string): void {
  const pkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: fallbackName, private: true, type: "module" }, null, 2) + "\n");
  } else {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (!pkg.type) {
        pkg.type = "module";
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      }
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

/** Remove agent .md files and lib *Entry functions whose state was removed from the skeletons. */
export function reconcile(reharnessDir: string, skeletons: Skeleton[]): void {
  const allAgents = new Set<string>();
  const codeStatesById = new Map<string, Set<string>>();
  for (const sk of skeletons) {
    const code = new Set<string>();
    for (const [name, s] of Object.entries(sk.states)) {
      if (s.type === "agent" || s.type === "interactive") allAgents.add(name);
      if (s.type === "code") code.add(name);
    }
    codeStatesById.set(sk.id, code);
  }

  const agentsDir = resolve(reharnessDir, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
      if (!allAgents.has(file.replace(/\.md$/, ""))) unlinkSync(resolve(agentsDir, file));
    }
  }

  const libDir = resolve(reharnessDir, "lib");
  if (!existsSync(libDir)) return;
  for (const [id, code] of codeStatesById) {
    const path = resolve(libDir, `${id}-states.ts`);
    if (!existsSync(path)) continue;
    const cleaned = pruneEntryFns(readFileSync(path, "utf-8"), code);
    if (cleaned !== null) writeFileSync(path, cleaned);
  }
}

/** Drop top-level `export function <name>Entry` blocks whose <name> isn't in the live set. */
function pruneEntryFns(source: string, liveStates: Set<string>): string | null {
  const lines = source.split("\n");
  const out: string[] = [];
  let dropping = false;
  let changed = false;

  for (const line of lines) {
    const m = line.match(/^export function (\w+)Entry\b/);
    if (m) {
      dropping = !liveStates.has(m[1]);
      if (dropping) { changed = true; continue; }
    } else if (dropping && /^export function \w+/.test(line)) {
      // next top-level function — stop dropping, evaluate this one
      const m2 = line.match(/^export function (\w+)Entry\b/);
      dropping = !!m2 && !liveStates.has(m2[1]);
      if (dropping) { changed = true; continue; }
    }
    if (!dropping) out.push(line);
  }
  return changed ? out.join("\n") : null;
}
