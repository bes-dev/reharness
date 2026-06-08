import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "fs";
import { resolve } from "path";

// Run-state persistence: a run's progress + terminal verdict on disk (state.json), and finding a resumable run.
// Resume is COARSE — only `current` + `data` are persisted, so resuming mid-composite re-runs that composite
// from the start (acceptable: composite steps re-derive, idempotent). See .claude/theory/runtime.md.

export interface SavedState {
  runId: string;
  current: string;
  data: Record<string, any>;
  retries: Record<string, number>;
  /** Terminal verdict, recorded once the run reaches a final state — the machine-readable signal `evolve`
   *  reads from disk (state.json otherwise loses the terminal: `current` becomes "__done__"). */
  status?: "success" | "error";
  /** On an error verdict: the stage that emitted the failing event into the error terminal (for diagnosis). */
  failedStage?: string;
  /** The raw CLI argv this run was invoked with (codegen stashes it as config.__argv) — lets `evolve` re-run
   *  the same command to confirm a heal actually fixed it. */
  argv?: string[];
  /** Degradations recorded via `c.warn` during a run that still SUCCEEDED — so a swallowed best-effort failure
   *  is visible to `evolve`. Each carries the stage that emitted it (so heal can target the leaf). */
  warnings?: { stage: string; message: string }[];
  /** Actual LLM spend for this run, summed from each agent leaf's Pi usage. A fully-deterministic (0-agent)
   *  pipeline records `agentRuns: 0` and `costUSD: 0`. Since reharness is self-hosted, this captures BOTH a
   *  compiled command's runtime cost AND `compile`'s own cost (the /generate meta-pipeline is itself a run). */
  usage?: { costUSD: number; tokensIn: number; tokensOut: number; agentRuns: number };
}

const stateFile = (dir: string) => resolve(dir, "state.json");

export function save(runDir: string, s: SavedState): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(stateFile(runDir), JSON.stringify(s, null, 2));
}

export function load(runDir: string): SavedState | null {
  if (!existsSync(stateFile(runDir))) return null;
  try { return JSON.parse(readFileSync(stateFile(runDir), "utf-8")); } catch { return null; }
}

/** Keep only the newest `keep` `run-*` dirs in `logsDir` (run ids are ISO timestamps, so name-sort == chrono);
 *  prune the rest. Bounds unbounded disk growth from accumulated runs. `keep <= 0` = keep all (disabled). Best-effort. */
export function pruneRuns(logsDir: string, keep: number): void {
  if (keep <= 0 || !existsSync(logsDir)) return;
  try {
    const runs = readdirSync(logsDir).filter(d => d.startsWith("run-")).sort().reverse();
    for (const d of runs.slice(keep)) rmSync(resolve(logsDir, d), { recursive: true, force: true });
  } catch { /* best-effort — a prune failure must never break a run */ }
}

export function findResumableRun(logsDir: string): string | null {
  if (!existsSync(logsDir)) return null;
  try {
    for (const d of readdirSync(logsDir).filter(d => d.startsWith("run-")).sort().reverse()) {
      const full = resolve(logsDir, d);
      const s = load(full);
      if (s && s.current !== "__done__") return full;
    }
  } catch { /* unreadable */ }
  return null;
}
