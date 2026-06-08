import { existsSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "fs";
import { resolve } from "path";
import { collectTraces } from "../runtime/trace.js";
import { commandAgentsDir, readJSON } from "./project-fs.js";
import { EVOLVE_GRACE } from "../config.js";
import { bundleAt } from "../layout.js";

/** Per-tool utility accounting — the RETENTION half of the two-stage gate (the utility problem, Minton 1988).
 *  A bound tool is kept only while it earns its place: indiscriminate caching slows the system (context bloat /
 *  dispatch cost). Utility accumulates over runs (frequency strengthens the estimate; N=1 still extracts). */
export interface ToolEntry { ref: string; leaf: string; cmdId: string; toolName: string; boundAt: number; runsSinceBind: number; calls: number; lastUsedRun: number }
export interface Ledger { runsTotal: number; tools: Record<string, ToolEntry> }

const ledgerPath = (reharnessDir: string) => resolve(bundleAt(reharnessDir).evolve, "ledger.json");

export function loadLedger(reharnessDir: string): Ledger {
  return readJSON<Ledger>(ledgerPath(reharnessDir), { runsTotal: 0, tools: {} });
}
export function saveLedger(reharnessDir: string, l: Ledger): void {
  mkdirSync(bundleAt(reharnessDir).evolve, { recursive: true });
  writeFileSync(ledgerPath(reharnessDir), JSON.stringify(l, null, 2) + "\n");
}

/** Record a freshly-bound tool (called from reconcile_tools), stamped with the current run total. */
export function recordBind(l: Ledger, ref: string, leaf: string, toolName: string, cmdId: string): void {
  if (l.tools[ref]) return;
  l.tools[ref] = { ref, leaf, cmdId, toolName, boundAt: l.runsTotal, runsSinceBind: 0, calls: 0, lastUsedRun: -1 };
}

/** One evolve cycle over the latest execution trace: ++runsSinceBind for every tool, and ++calls for each tool
 *  whose registered name appears as a `[tool] <name>` call in the run's per-leaf logs. */
export function updateLedger(l: Ledger, runDir: string): void {
  l.runsTotal++;
  const trace = collectTraces(runDir);
  for (const e of Object.values(l.tools)) {
    e.runsSinceBind++;
    // a tool call shows in the trace as `[tool] <toolName>`
    if (new RegExp(`\\[tool\\]\\s+${e.toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(trace)) {
      e.calls++; e.lastUsedRun = l.runsTotal;
    }
  }
}

/** Retention trim (TroVE λ = ½·log₁₀(n); Minton utility): a tool past a grace period whose call-frequency is
 *  below threshold is UNBOUND (removed from its leaf's harness.json) and archived. Returns the trimmed refs.
 *  Grace: a tool is never trimmed within its first `grace` runs (needs a chance to be used). */
export function retentionTrim(l: Ledger, reharnessDir: string, grace = EVOLVE_GRACE): string[] {
  const archive = resolve(bundleAt(reharnessDir).evolve, ".archive");
  // keep iff calls ≥ ½·log10(n). Floor n at 10 so the threshold is ~0.5 (not ~0) in early runs — a tool must
  // be used at least once in its first handful of runs to survive, instead of being kept by a near-zero bar.
  const threshold = 0.5 * Math.log10(Math.max(l.runsTotal, 10));
  const trimmed: string[] = [];
  for (const [ref, e] of Object.entries(l.tools)) {
    if (e.runsSinceBind < grace) continue;
    if (e.calls >= threshold) continue; // earns its place
    // unbind: drop the ref from the leaf's harness.json extensions
    const hp = resolve(commandAgentsDir(reharnessDir, e.cmdId), e.leaf, "harness.json");
    if (existsSync(hp)) {
      try {
        const h = readJSON<{ extensions?: string[] }>(hp, {});
        if (Array.isArray(h.extensions)) {
          h.extensions = h.extensions.filter((x: string) => x !== ref);
          if (!h.extensions.length) delete h.extensions;
          writeFileSync(hp, JSON.stringify(h, null, 2) + "\n");
        }
      } catch { /* leave harness as-is */ }
    }
    // archive the routine + ALL its rendered backend wrappers + self-test (recoverable), drop the ledger entry
    const leafDir = resolve(bundleAt(reharnessDir).tools, e.cmdId, e.leaf);
    const stem = ref.split("/").pop()!.replace(/\.routine\.mjs$/, ""); // <name> (the file naming invariant == tool.name)
    if (existsSync(leafDir)) {
      const dest = resolve(archive, e.cmdId, e.leaf);
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(leafDir).filter(f => f.startsWith(stem + "."))) // <name>.routine.mjs + .pi.mjs + .mcp.mjs + .test.mjs
        try { renameSync(resolve(leafDir, f), resolve(dest, f)); } catch { /* ignore */ }
    }
    delete l.tools[ref];
    trimmed.push(ref);
  }
  return trimmed;
}
