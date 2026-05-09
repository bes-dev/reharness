import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { resolve, isAbsolute } from "path";
import type {
  PipelineDefinition, StateContext, Pipeline, RunOptions,
  ActiveState, FinalState, StateDefinition, TransitionTarget, GuardedTransition,
} from "./types.js";
import { runAgentProcess, runInteractiveProcess } from "./agent.js";

// ── State persistence ───────────────────────────────────────────

interface FSMState {
  runId: string;
  current: string;
  data: Record<string, any>;
  retries: Record<string, number>;
}

function stateFile(runDir: string): string {
  return resolve(runDir, "state.json");
}

function saveState(runDir: string, state: FSMState): void {
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(stateFile(runDir), JSON.stringify(state, null, 2));
  } catch {
    writeFileSync(stateFile(runDir), JSON.stringify({ ...state, data: {} }, null, 2));
  }
}

function loadState(runDir: string): FSMState | null {
  const path = stateFile(runDir);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; /* corrupt or missing state file */ }
}

export function findResumableRun(logsDir: string): string | null {
  if (!existsSync(logsDir)) return null;
  try {
    const dirs = readdirSync(logsDir).filter(d => d.startsWith("run-")).sort().reverse();
    for (const dir of dirs) {
      const full = resolve(logsDir, dir);
      const state = loadState(full);
      if (state && state.current !== "__done__") return full;
    }
  } catch { /* unreadable logs directory */ }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────

function resolveAgentsDir(agents: string | undefined, cwd: string): string {
  if (!agents) return resolve(cwd, ".reharness", "agents");
  if (isAbsolute(agents)) return agents;
  return resolve(cwd, agents);
}

function isFinal<C extends Record<string, any>>(state: StateDefinition<C>): state is FinalState<C> {
  return "type" in state && (state as FinalState<C>).type === "final";
}

function resolveTransition<C extends Record<string, any>>(
  target: TransitionTarget<C>,
  ctx: StateContext<C>,
): string | null {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      if (!t.guard || t.guard(ctx)) return t.target;
    }
    return null;
  }
  if (!target.guard || target.guard(ctx)) return target.target;
  return null;
}

// ── Validation ──────────────────────────────────────────────────

function validate<C extends Record<string, any>>(def: PipelineDefinition<C>): void {
  const names = Object.keys(def.states);
  const errors: string[] = [];

  if (!names.includes(def.initial)) {
    errors.push(`Initial state "${def.initial}" does not exist. States: ${names.join(", ")}`);
  }

  let hasFinal = false;

  for (const [name, state] of Object.entries(def.states)) {
    if (isFinal(state)) {
      hasFinal = true;
      continue;
    }

    const active = state as ActiveState<C>;
    const transitions = typeof active.on === "string"
      ? { DONE: active.on }
      : active.on;

    for (const [event, target] of Object.entries(transitions)) {
      const targets: string[] = [];
      if (typeof target === "string") targets.push(target);
      else if (Array.isArray(target)) targets.push(...target.map(t => t.target));
      else targets.push(target.target);

      for (const t of targets) {
        if (!names.includes(t)) {
          errors.push(`State "${name}" → event "${event}" → target "${t}" does not exist`);
        }
      }
    }
  }

  if (!hasFinal) {
    errors.push("No final state defined. Add at least one state with { type: 'final', status: 'success' | 'error' }");
  }

  if (errors.length > 0) {
    throw new Error(`Pipeline validation failed:\n  ${errors.join("\n  ")}`);
  }
}

// ── Pipeline runner ─────────────────────────────────────────────

export function definePipeline<C extends Record<string, any>>(def: PipelineDefinition<C>): Pipeline {
  validate(def);

  const cwd = def.cwd || process.cwd();
  const logsDir = def.logsDir || resolve(cwd, "logs");
  const agentsDir = resolveAgentsDir(def.agents, cwd);
  const piBinary = def.piBinary || "pi";
  let stepCounter = 0;

  async function run(emit: (msg: string) => void, options?: RunOptions): Promise<"success" | "error"> {
    const signal = options?.signal;
    const onStatus = options?.onStatus || (() => {});
    const piModel = options?.piModel || def.piModel;
    const retryCounts: Record<string, number> = {};
    let data = { ...(options?.data || {}) };
    let current = def.initial;

    stepCounter = 0;

    // Resume
    let runId: string;
    let runDir: string;

    if (options?.resume) {
      const latestDir = findResumableRun(logsDir);
      if (latestDir) {
        const saved = loadState(latestDir);
        if (saved) {
          runId = saved.runId;
          runDir = latestDir;
          current = saved.current;
          Object.assign(data, saved.data);
          Object.assign(retryCounts, saved.retries);
          emit(`Resuming from ${current} (run ${runId})`);
        } else {
          runId = newRunId();
          runDir = resolve(logsDir, `run-${runId}`);
        }
      } else {
        runId = newRunId();
        runDir = resolve(logsDir, `run-${runId}`);
      }
    } else {
      runId = newRunId();
      runDir = resolve(logsDir, `run-${runId}`);
    }

    mkdirSync(runDir, { recursive: true });

    // Build context
    const ctx: StateContext<C> = {
      config: def.config,
      emit,
      status: onStatus,
      data,
      runId,
      runDir,
      retry: (key) => { retryCounts[key] = (retryCounts[key] || 0) + 1; return retryCounts[key]; },
      retries: (key) => retryCounts[key] || 0,

      agent: async (name, task, opts?) => {
        if (signal?.aborted) throw new Error("Aborted");
        const promptFile = resolve(agentsDir, `${name}.md`);
        if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);

        stepCounter++;
        const padded = String(stepCounter).padStart(2, "0");
        const r = await runAgentProcess({
          prompt: promptFile, task, cwd,
          onLine: emit, onStatus,
          logFile: resolve(runDir, `${padded}-${name}.md`),
          piBinary, piModel: opts?.model || piModel, signal,
        });
        if (signal?.aborted) throw new Error("Aborted");
        if (r.exitCode !== 0) throw new Error(`Agent "${name}" failed (exit ${r.exitCode})`);
        emit(`✓ ${name}`);
      },

      interactive: async (name, task, opts?) => {
        if (signal?.aborted) throw new Error("Aborted");
        const promptFile = resolve(agentsDir, `${name}.md`);
        if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);

        stepCounter++;
        const padded = String(stepCounter).padStart(2, "0");
        await runInteractiveProcess({
          prompt: promptFile, task, cwd,
          onLine: emit, onStatus,
          logFile: resolve(runDir, `${padded}-${name}-interactive.md`),
          piBinary, piModel: opts?.model || piModel, signal,
        });
        if (signal?.aborted) throw new Error("Aborted");
        emit(`✓ ${name} (interactive)`);
      },

      shell: (cmd, label?) => {
        if (signal?.aborted) return false;
        const lbl = label || cmd.slice(0, 30);
        try {
          execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
          emit(`✓ ${lbl}`);
          return true;
        } catch (err: any) {
          emit(`✗ ${lbl}`);
          const detail = (err.stderr?.toString().trim() || err.stdout?.toString().trim());
          if (detail) detail.split("\n").slice(-5).forEach((l: string) => emit(`  ${l}`));
          return false;
        }
      },
    };

    // ── FSM loop ────────────────────────────────────────────────
    while (true) {
      if (signal?.aborted) {
        emit("⚠ Aborted by user");
        saveState(runDir, { runId, current, data, retries: retryCounts });
        return "error";
      }

      const state = def.states[current];
      if (!state) {
        emit(`✗ Unknown state "${current}"`);
        return "error";
      }

      saveState(runDir, { runId, current, data, retries: retryCounts });
      emit(`── ${current} ──`);

      // Final state
      if (isFinal(state)) {
        if (state.entry) {
          try { await state.entry(ctx as StateContext<any>); } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            emit(`⚠ final state entry error: ${msg}`);
          }
        }
        saveState(runDir, { runId, current: "__done__", data, retries: retryCounts });
        return state.status;
      }

      // Active state
      const active = state as ActiveState<C>;

      try {
        // Entry action — returns event name or void (= DONE)
        const event = await active.entry(ctx) || "DONE";

        // Resolve transition
        const transitions = typeof active.on === "string"
          ? { DONE: active.on as string }
          : active.on;

        const target = transitions[event];
        if (!target) {
          emit(`✗ State "${current}" has no transition for event "${event}"`);
          saveState(runDir, { runId, current, data, retries: retryCounts });
          return "error";
        }

        const next = resolveTransition(target, ctx);
        if (!next) {
          emit(`✗ State "${current}" event "${event}": all guards failed`);
          saveState(runDir, { runId, current, data, retries: retryCounts });
          return "error";
        }

        // Exit action
        if (active.exit) await active.exit(ctx);

        current = next;
      } catch (err: any) {
        if (signal?.aborted) {
          emit("⚠ Aborted by user");
        } else {
          emit(`✗ ${current} failed: ${err.message}`);
        }
        saveState(runDir, { runId, current, data, retries: retryCounts });
        return "error";
      }
    }
  }

  return { run, states: def.states as Record<string, any>, config: def.config };
}

function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
