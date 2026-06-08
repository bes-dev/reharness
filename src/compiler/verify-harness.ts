import { existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { resolve, relative, isAbsolute } from "path";
import { createHash } from "crypto";
import { layout, bundleAt } from "../layout.js";

/** Per-leaf harness verdict. `hasHarness` = a harness.json exists for the leaf (most leaves have none). */
export interface LeafHarnessResult { name: string; ok: boolean; reason: string; badFiles: string[]; hasHarness: boolean; }
/** The enhance gate's report: per-leaf validity + any base files enhance illegitimately modified. */
export interface HarnessReport { leaves: LeafHarnessResult[]; baseChanged: string[]; }

/** Every agent's own directory across the per-command namespace: `agents/<cmdId>/<name>/`. */
function agentDirs(root: string): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  const agentsRoot = bundleAt(root).agents;
  if (!existsSync(agentsRoot)) return out;
  for (const cmd of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!cmd.isDirectory()) continue;
    const cmdPath = resolve(agentsRoot, cmd.name);
    for (const a of readdirSync(cmdPath, { withFileTypes: true })) {
      if (a.isDirectory()) out.push({ name: a.name, dir: resolve(cmdPath, a.name) });
    }
  }
  return out;
}

/** Base files enhance must NEVER touch — everything the verified pipeline runs on, EXCEPT the harness layer
 *  (agents/<cmd>/<name>/harness.json + .../skills/). Used for the untouched-snapshot guarantee. */
function baseFiles(target: string): string[] {
  const L = layout(target);
  const out: string[] = [];
  const add = (dir: string, keep: (f: string) => boolean) => {
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (keep(f)) out.push(resolve(dir, f));
  };
  add(L.lib, f => f.endsWith(".ts"));
  add(L.skeletons, f => f.endsWith(".xml"));
  add(L.commands, f => f.endsWith(".ts"));
  for (const { dir } of agentDirs(L.root)) {
    const sys = resolve(dir, "SYSTEM.md");
    if (existsSync(sys)) out.push(sys);
  }
  return out;
}

const hashFile = (p: string) => existsSync(p) ? createHash("sha1").update(readFileSync(p)).digest("hex") : "";

/** Snapshot the verified base before enhance runs, so reconcile can restore anything enhance wrongly modified. */
export function snapshotBase(target: string, snapshotDir: string): void {
  rmSync(snapshotDir, { recursive: true, force: true });
  const root = layout(target).root;
  for (const f of baseFiles(target)) {
    const dest = resolve(snapshotDir, relative(root, f));
    mkdirSync(resolve(dest, ".."), { recursive: true });
    copyFileSync(f, dest);
  }
}

/** Restore the listed base files from the snapshot (used by reconcile to keep the base byte-identical). */
export function restoreBase(target: string, snapshotDir: string, changed: string[]): void {
  const root = layout(target).root;
  for (const f of changed) {
    const snap = resolve(snapshotDir, relative(root, f));
    if (existsSync(snap)) copyFileSync(snap, f);   // modified → restore the pre-enhance version
    else rmSync(f, { force: true });               // enhance-created (no snapshot) → it shouldn't exist; remove it
  }
}

/** Deterministic gate for the enhance layer — symmetric to `verifyGenerated` for the base. Checks, all static:
 *  (1) every agents/<name>/harness.json parses; (2) its skills/extensions paths resolve to existing files;
 *  (3) the base is byte-identical to the pre-enhance snapshot. Returns a report; mutation (discard/restore)
 *  is reconcile's job. NB: a `model` field is NOT an error — it's a valid runtime field (loadHarness reads it);
 *  enhance is merely told (in its prompt) not to author one. The base TS/skeleton being unchanged means the
 *  pipeline still loads exactly as it did at verify-time, so no re-compile probe is needed here. */
export function verifyHarness(target: string): HarnessReport {
  const root = layout(target).root;
  const snapshotDir = resolve(layout(target).scratch, ".base-snapshot");

  const baseChanged: string[] = [];
  for (const f of baseFiles(target)) {
    const snap = resolve(snapshotDir, relative(root, f));
    // flag MODIFIED and newly-CREATED base files (a missing snapshot ⇒ enhance created it — also a violation). hashFile("")="".
    if (hashFile(f) !== hashFile(snap)) baseChanged.push(f);
  }

  const leaves: LeafHarnessResult[] = [];
  for (const { name, dir } of agentDirs(root)) {
    const hp = resolve(dir, "harness.json");
    if (!existsSync(hp)) continue; // no harness ⇒ Pi defaults; the correct, common outcome
    const res: LeafHarnessResult = { name, ok: true, reason: "", badFiles: [hp], hasHarness: true };
    let h: any;
    try { h = JSON.parse(readFileSync(hp, "utf-8")); }
    catch (e: any) { res.ok = false; res.reason = `harness.json is invalid JSON: ${e.message}`; leaves.push(res); continue; }
    const paths = [...(Array.isArray(h.skills) ? h.skills : []), ...(Array.isArray(h.extensions) ? h.extensions : [])];
    const missing = paths.filter((p: string) => !existsSync(isAbsolute(p) ? p : resolve(dir, p))); // relative to the leaf's own dir
    if (missing.length) { res.ok = false; res.reason = `unresolved skill/extension path(s): ${missing.join(", ")}`; }
    leaves.push(res);
  }

  return { leaves, baseChanged };
}
