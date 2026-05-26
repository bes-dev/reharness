import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { resolve, isAbsolute } from "path";
import type {
  PipelineDefinition, StateContext, Pipeline, RunOptions,
  ActiveState, ApprovalState, SwitchState, ParallelState, LoopState, FinalState, StateDefinition, TransitionTarget,
  ApprovalCheckpoint, BranchResult,
} from "./types.js";
import { runAgent, runInteractive } from "./agent.js";

// ── Persistence ─────────────────────────────────────────────────

interface SavedState {
  runId: string;
  current: string;
  data: Record<string, any>;
  retries: Record<string, number>;
}

const stateFile = (dir: string) => resolve(dir, "state.json");

function save(runDir: string, s: SavedState): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(stateFile(runDir), JSON.stringify(s, null, 2));
}

function load(runDir: string): SavedState | null {
  if (!existsSync(stateFile(runDir))) return null;
  try { return JSON.parse(readFileSync(stateFile(runDir), "utf-8")); } catch { return null; }
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

// ── Type guards & resolution ────────────────────────────────────

const isFinal = <C extends Record<string, any>>(s: StateDefinition<C>): s is FinalState<C> =>
  "type" in s && s.type === "final";
const isApproval = <C extends Record<string, any>>(s: StateDefinition<C>): s is ApprovalState<C> =>
  "type" in s && s.type === "approval";
const isSwitch = <C extends Record<string, any>>(s: StateDefinition<C>): s is SwitchState<C> =>
  "type" in s && s.type === "switch";
const isParallel = <C extends Record<string, any>>(s: StateDefinition<C>): s is ParallelState<C> =>
  "type" in s && s.type === "parallel";
const isLoop = <C extends Record<string, any>>(s: StateDefinition<C>): s is LoopState<C> =>
  "type" in s && s.type === "loop";

function resolveTarget<C extends Record<string, any>>(t: TransitionTarget<C>, ctx: StateContext<C>): string | null {
  if (typeof t === "string") return t;
  const list = Array.isArray(t) ? t : [t];
  for (const g of list) if (!g.guard || g.guard(ctx)) return g.target;
  return null;
}

// ── Validation ──────────────────────────────────────────────────

function validate<C extends Record<string, any>>(def: PipelineDefinition<C>): void {
  const names = new Set(Object.keys(def.states));
  const errors: string[] = [];

  if (!names.has(def.initial)) errors.push(`Initial state "${def.initial}" not in states`);
  let hasFinal = false;

  for (const [name, state] of Object.entries(def.states)) {
    if (isFinal(state)) { hasFinal = true; continue; }

    if (isSwitch(state)) {
      if (!state.branches?.length) { errors.push(`Switch "${name}" has no branches`); continue; }
      for (const b of state.branches) {
        if (!names.has(b.target)) errors.push(`Switch "${name}" → "${b.target}" does not exist`);
      }
      continue;
    }

    if (isParallel(state)) {
      if (typeof state.over !== "function") errors.push(`Parallel "${name}" missing 'over' function`);
      if (!names.has(state.branch)) errors.push(`Parallel "${name}" branch "${state.branch}" does not exist`);
      if (!names.has(state.join)) errors.push(`Parallel "${name}" join "${state.join}" does not exist`);
      continue;
    }

    if (isLoop(state)) {
      if (!state.steps?.length) errors.push(`Loop "${name}" has no steps`);
      else for (const s of state.steps) if (!names.has(s)) errors.push(`Loop "${name}" step "${s}" does not exist`);
      if (!names.has(state.join)) errors.push(`Loop "${name}" join "${state.join}" does not exist`);
      if (!state.max && !state.exit) errors.push(`Loop "${name}" needs at least one of max/exit`);
      continue;
    }

    const on = isApproval(state) ? state.on
      : typeof (state as ActiveState<C>).on === "string"
        ? { DONE: (state as ActiveState<C>).on as string }
        : (state as ActiveState<C>).on as Record<string, TransitionTarget<C>>;

    if (isApproval(state)) {
      if (!state.prompt) errors.push(`Approval "${name}" missing prompt`);
      if (state.autoEvent && !on[state.autoEvent]) errors.push(`Approval "${name}" auto-event "${state.autoEvent}" not in transitions`);
    }

    for (const [event, target] of Object.entries(on)) {
      const targets = typeof target === "string" ? [target]
        : Array.isArray(target) ? target.map(t => t.target)
        : [target.target];
      for (const t of targets) {
        if (!names.has(t)) errors.push(`State "${name}" event "${event}" → "${t}" does not exist`);
      }
    }
  }

  if (!hasFinal) errors.push("No final state defined");
  if (errors.length) throw new Error(`Pipeline validation failed:\n  ${errors.join("\n  ")}`);
}

// ── Pipeline runner ─────────────────────────────────────────────

const newRunId = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export function definePipeline<C extends Record<string, any>>(def: PipelineDefinition<C>): Pipeline {
  validate(def);

  const cwd = def.cwd || process.cwd();
  const logsDir = def.logsDir || resolve(cwd, "logs");
  const agentsDir = def.agents
    ? (isAbsolute(def.agents) ? def.agents : resolve(cwd, def.agents))
    : resolve(cwd, ".reharness", "agents");

  async function run(emit: (msg: string) => void, opts: RunOptions = {}): Promise<"success" | "error"> {
    const signal = opts.signal;
    const onStatus = opts.onStatus || (() => {});
    const piModel = opts.piModel || def.piModel;
    const piBinary = def.piBinary || "pi";

    const retries: Record<string, number> = {};
    const approvalRounds: Record<string, number> = {};
    const approvalFeedback: Record<string, string[]> = {};
    let data: Record<string, any> = { ...(opts.data || {}) };
    let current = def.initial;
    let stepCounter = 0;

    let runId: string, runDir: string;
    if (opts.resume) {
      const latest = findResumableRun(logsDir);
      const saved = latest ? load(latest) : null;
      if (latest && saved) {
        runId = saved.runId; runDir = latest;
        current = saved.current;
        Object.assign(data, saved.data);
        Object.assign(retries, saved.retries);
        emit(`Resuming from ${current} (run ${runId})`);
      } else {
        runId = newRunId(); runDir = resolve(logsDir, `run-${runId}`);
      }
    } else {
      runId = newRunId(); runDir = resolve(logsDir, `run-${runId}`);
    }
    mkdirSync(runDir, { recursive: true });

    const snapshot = (cur: string): SavedState => ({ runId, current: cur, data, retries });
    const fail = (msg: string): "error" => { emit(msg); save(runDir, snapshot(current)); return "error"; };

    const ctx: StateContext<C> = {
      config: def.config,
      emit, status: onStatus, data, runId, runDir,
      retry: (k) => (retries[k] = (retries[k] || 0) + 1),
      retries: (k) => retries[k] || 0,
      agent: async (name, task, o) => {
        if (signal?.aborted) throw new Error("Aborted");
        const logFile = resolve(runDir, `${String(++stepCounter).padStart(2, "0")}-${name}.md`);
        const promptFile = resolve(agentsDir, `${name}.md`);
        if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);
        await runAgent({
          prompt: promptFile, task, cwd,
          onLine: emit, onStatus,
          logFile, piBinary, piModel: o?.model || piModel, signal,
        });
        emit(`✓ ${name}`);
      },
      interactive: async (name, task, o) => {
        if (signal?.aborted) throw new Error("Aborted");
        const promptFile = resolve(agentsDir, `${name}.md`);
        if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);

        const artifacts = o?.artifacts || [];
        const absArtifacts = artifacts.map(a => isAbsolute(a) ? a : resolve(cwd, a));
        for (let i = 0; i < absArtifacts.length; i++) {
          if (!existsSync(absArtifacts[i])) throw new Error(`Interactive artifact missing: ${artifacts[i]}`);
        }

        emit(`▷ ${name} (interactive — exit Pi to continue)`);
        await runInteractive({
          prompt: promptFile, task, cwd,
          piBinary, piModel: o?.model || piModel, signal,
        });

        for (let i = 0; i < absArtifacts.length; i++) {
          if (!existsSync(absArtifacts[i])) throw new Error(`Interactive contract violated: ${artifacts[i]} was deleted`);
          if (absArtifacts[i].endsWith(".xml")) {
            try { readFileSync(absArtifacts[i], "utf-8"); } catch (e: any) { throw new Error(`${artifacts[i]} unreadable: ${e.message}`); }
          }
        }
        emit(`✓ ${name}`);
      },
      shell: (cmd, label) => {
        if (signal?.aborted) return false;
        const lbl = label || cmd.slice(0, 30);
        try {
          execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
          emit(`✓ ${lbl}`); return true;
        } catch (err: any) {
          emit(`✗ ${lbl}`);
          const detail = (err.stderr?.toString().trim() || err.stdout?.toString().trim());
          if (detail) detail.split("\n").slice(-5).forEach((l: string) => emit(`  ${l}`));
          return false;
        }
      },
    };

    while (true) {
      if (signal?.aborted) return fail("⚠ Aborted by user");

      const state = def.states[current];
      if (!state) return fail(`✗ Unknown state "${current}"`);

      save(runDir, snapshot(current));
      emit(`── ${current} ──`);

      // Final
      if (isFinal(state)) {
        if (state.entry) {
          try { await state.entry(ctx as StateContext<any>); }
          catch (err: any) { emit(`⚠ final entry error: ${err.message}`); }
        }
        save(runDir, { ...snapshot(current), current: "__done__" });
        return state.status;
      }

      // Approval
      if (isApproval(state)) {
        const round = (approvalRounds[current] = (approvalRounds[current] || 0) + 1);
        const events = Object.keys(state.on);
        const autoEvent = state.autoEvent || events[0];

        const artifacts: ApprovalCheckpoint["artifacts"] = [];
        for (const rel of state.artifacts || []) {
          const full = isAbsolute(rel) ? rel : resolve(cwd, rel);
          if (existsSync(full)) {
            try { artifacts.push({ path: rel, content: readFileSync(full, "utf-8") }); }
            catch { /* unreadable */ }
          }
        }

        const checkpoint: ApprovalCheckpoint = {
          state: current, prompt: state.prompt, events, autoEvent, artifacts, round,
          priorFeedback: approvalFeedback[current] || [],
        };

        let resolution;
        if (opts.autoApprove) {
          emit(`⚠ auto-approve: ${current} → ${autoEvent}`);
          resolution = { event: autoEvent };
        } else if (opts.approvalHandler) {
          try { resolution = await opts.approvalHandler(checkpoint); }
          catch (err: any) { return fail(`✗ approval handler failed: ${err.message}`); }
        } else {
          return fail(`✗ approval "${current}" reached without --auto-approve or approvalHandler`);
        }

        if (!events.includes(resolution.event)) {
          return fail(`✗ approval "${current}": invalid event "${resolution.event}" (allowed: ${events.join(", ")})`);
        }

        if (resolution.feedback?.trim()) {
          const dir = resolve(cwd, ".reharness", "feedback");
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${current}-round-${round}.md`), resolution.feedback);
          (approvalFeedback[current] ||= []).push(resolution.feedback);
          data.__allFeedback = approvalFeedback[current];
        }

        const next = resolveTarget(state.on[resolution.event], ctx);
        if (!next) return fail(`✗ approval "${current}" → "${resolution.event}": no resolvable target`);
        current = next;
        continue;
      }

      // Switch
      if (isSwitch(state)) {
        const next = resolveTarget(state.branches, ctx);
        if (!next) return fail(`✗ switch "${current}": no branch matched`);
        current = next;
        continue;
      }

      // Parallel — fan out, capture per-branch results, transition to join.
      if (isParallel(state)) {
        const branchName = state.branch;
        const joinName = state.join;
        const capRaw = state.concurrency;
        let items: any[];
        try { items = state.over(ctx); }
        catch (err: any) { return fail(`✗ parallel "${current}" over: ${err.message}`); }
        if (!Array.isArray(items)) return fail(`✗ parallel "${current}" over: expected array, got ${typeof items}`);

        const branchState = def.states[branchName] as ActiveState<C> | undefined;
        if (!branchState || !("entry" in branchState)) {
          return fail(`✗ parallel "${current}" branch "${branchName}" must be an active state`);
        }

        const parallelDir = resolve(cwd, ".reharness", "parallel", current);
        mkdirSync(parallelDir, { recursive: true });

        const cap = Math.max(1, capRaw || items.length || 1);
        const results: BranchResult[] = new Array(items.length);
        let cursor = 0;
        emit(`▷ parallel ${current}: ${items.length} branch(es), concurrency=${Math.min(cap, items.length)}`);

        async function runBranch(index: number): Promise<void> {
          if (signal?.aborted) {
            results[index] = { index, input: items[index], dir: "", ok: false, error: "Aborted" };
            return;
          }
          const branchDir = resolve(parallelDir, String(index));
          mkdirSync(branchDir, { recursive: true });
          const branchCtx: StateContext<C> = {
            ...ctx,
            runDir: branchDir,
            branchInput: items[index],
            branchIndex: index,
            branchDir,
          };
          try {
            await (branchState as ActiveState<C>).entry(branchCtx);
            results[index] = { index, input: items[index], dir: branchDir, ok: true };
          } catch (err: any) {
            results[index] = { index, input: items[index], dir: branchDir, ok: false, error: err.message };
            emit(`✗ branch ${index} (${branchName}): ${err.message}`);
          }
        }

        async function worker(): Promise<void> {
          while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            await runBranch(i);
          }
        }

        await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()));

        if (signal?.aborted) return fail("⚠ Aborted by user");

        data.branches = results;
        const okCount = results.filter(r => r.ok).length;
        emit(`✓ parallel ${current}: ${okCount}/${items.length} ok`);
        current = joinName;
        continue;
      }

      // Loop — run steps in sequence per iteration; exit when exit() truthy or iter >= max.
      if (isLoop(state)) {
        const steps = state.steps;
        const joinName = state.join;
        const max = state.max;
        const exitFn = state.exit;
        const loopDir = resolve(cwd, ".reharness", "loop", current);
        mkdirSync(loopDir, { recursive: true });

        emit(`▷ loop ${current}: max=${max ?? "∞"}, steps=${steps.length}`);
        let iter = 0;
        while (true) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          data.iteration = iter;
          const iterDir = resolve(loopDir, String(iter));
          mkdirSync(iterDir, { recursive: true });

          for (const stepName of steps) {
            const stepState = def.states[stepName] as ActiveState<C> | undefined;
            if (!stepState || !("entry" in stepState)) {
              return fail(`✗ loop "${current}" step "${stepName}" must be an active state`);
            }
            const stepCtx: StateContext<C> = { ...ctx, runDir: iterDir };
            try {
              await stepState.entry(stepCtx);
            } catch (err: any) {
              return fail(`✗ loop "${current}" iter ${iter} step "${stepName}" failed: ${err.message}`);
            }
          }

          iter++;
          const shouldExit = (exitFn && exitFn(ctx)) || (max !== undefined && iter >= max);
          if (shouldExit) {
            emit(`✓ loop ${current}: ${iter} iteration(s)`);
            data.iterations = iter;
            current = joinName;
            break;
          }
        }
        continue;
      }

      // Active
      const active = state as ActiveState<C>;
      let event: string;
      try { event = (await active.entry(ctx)) || "DONE"; }
      catch (err: any) {
        if (signal?.aborted) return fail("⚠ Aborted by user");
        return fail(`✗ ${current} failed: ${err.message}`);
      }

      const transitions: Record<string, TransitionTarget<C>> = typeof active.on === "string"
        ? { DONE: active.on } : active.on;

      const target = transitions[event];
      if (!target) return fail(`✗ State "${current}" has no transition for event "${event}"`);

      const next = resolveTarget(target, ctx);
      if (!next) return fail(`✗ State "${current}" event "${event}": all guards failed`);

      if (active.exit) await active.exit(ctx);
      current = next;
    }
  }

  return { run, states: def.states as Record<string, any>, config: def.config };
}
