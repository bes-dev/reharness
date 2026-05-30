import { execSync, spawn } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { resolve, isAbsolute } from "path";
import { createServer } from "http";
import type {
  PipelineDefinition, StateContext, Pipeline, RunOptions,
  ActiveState, ApprovalState, SwitchState, ParallelState, LoopState, CallState, WaitState, FinalState, StateDefinition, TransitionTarget,
  ApprovalCheckpoint, BranchResult,
} from "./types.js";
import { runAgent, runInteractive } from "./agent.js";
import { formatDuration } from "../term.js";

/**
 * Execution model — a **deterministic hierarchical Moore-action transducer with run-to-completion (RTC)**.
 * A deliberate, well-defined restriction of the UML/Harel hierarchical state machine:
 *
 *  - **States as Moore actions.** Each active state runs an `entry` action (agent / code / set / interactive)
 *    to completion, then emits ONE event symbol — the outcome of its own computation — not an external input.
 *    There are no Mealy transition-actions and no exit/entry-on-nesting actions; the action is tied to the state.
 *  - **Run-to-completion.** The main loop `await`s the full action before selecting a transition (line: outer
 *    FSM loop). There is no event queue and no preemption — exactly one event per step — so RTC's "no internal
 *    concurrency within a step" holds trivially. (`wait` states are the only external-signal source.)
 *  - **Total, deterministic transition function.** δ(state, event) is resolved by `transitions[event]`, then by
 *    ORDERED first-true guard (`resolveTarget`) — stricter than UML, which leaves guard order unspecified.
 *    Every gap fails LOUD (`fail(...)`): unhandled event, no-guard-match, switch with no matching branch. The
 *    machine never silently stalls.
 *  - **Hierarchical composites are RTC sub-computations**, not orthogonal regions: `parallel` is a fork-join
 *    over a data array (no inter-branch event broadcast), `loop` is BOUNDED iteration (`max` required ⇒
 *    guaranteed termination; `exit` is an early-out), `call` is a sub-machine. They are run by recursion
 *    (`executeStateOnce`/`runParallel`/`runLoop`) and return a completion — the top level stays single-active.
 *  - **Parallelism is REAL for agent branches, cooperative for code.** `runParallel` is a worker pool of
 *    `concurrency` coroutines on Node's single event loop. An agent branch `spawn`s a separate `pi` OS process
 *    and awaits it, so up to `concurrency` agent subprocesses (and their LLM calls) run genuinely in parallel —
 *    wall-clock ≈ slowest branch. A pure-CPU code branch, by contrast, runs IN the event loop and does not get
 *    CPU parallelism (branches interleave only at await points). Correct for this I/O-bound workload; if a code
 *    branch ever needed true CPU parallelism it would require worker_threads (we don't).
 *
 * INVARIANTS callers must respect (the RTC boundary):
 *  - A `parallel` branch must NOT write shared `ctx.data` (branches run concurrently via Promise.all → races).
 *    Branches communicate only through their isolated output dirs; the JOIN reads `data.branches` afterwards.
 *  - Resume is COARSE: only `current` + `data` are persisted, so resuming mid-composite re-runs that composite
 *    from the start (acceptable because composite steps are idempotent-by-design — they re-derive, not append).
 */

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
const isCall = <C extends Record<string, any>>(s: StateDefinition<C>): s is CallState<C> =>
  "type" in s && s.type === "call";
const isWait = <C extends Record<string, any>>(s: StateDefinition<C>): s is WaitState<C> =>
  "type" in s && s.type === "wait";

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

    if (isCall(state)) {
      if (typeof state.callFactory !== "function") errors.push(`Call "${name}" missing callFactory`);
      if (typeof state.argsFn !== "function") errors.push(`Call "${name}" missing argsFn`);
      for (const ev of ["success", "error"]) {
        if (!state.on?.[ev]) errors.push(`Call "${name}" missing on event "${ev}"`);
      }
      continue;
    }

    if (isWait(state)) {
      if (!state.on?.["DONE"]) errors.push(`Wait "${name}" missing on event "DONE"`);
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

    // ── Instance-vector workspace addressing (the polyhedral iteration-space model) ──
    // Every stage execution is identified by its INSTANCE VECTOR: one index per enclosing composite (a
    // parallel's branch index / a loop's iteration), outermost-first. Its output dir is <workRoot>/<stage>/<i0>/…
    // Producer-write, recorded dir, and consumer-read all derive from (stage, instance vector) → no drift.
    const workRoot = resolve(runDir, "work");

    // Enclosing-composite chain per state (mirrors the compiler's enclosingScope, computed from def.states).
    const scope = new Map<string, string[]>();
    {
      const parent = new Map<string, string>();
      for (const [n, s] of Object.entries(def.states)) {
        if (isParallel(s)) parent.set(s.branch, n);
        if (isLoop(s)) for (const step of s.steps) parent.set(step, n);
      }
      for (const n of Object.keys(def.states)) {
        const chain: string[] = [];
        for (let cur = n; parent.has(cur); ) { const p = parent.get(cur)!; chain.unshift(p); cur = p; }
        scope.set(n, chain);
      }
    }
    const commonPrefix = (a: string[], b: string[]): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

    const instDir = (stage: string, path: number[]): string => {
      const d = resolve(workRoot, stage, ...path.map(String));
      mkdirSync(d, { recursive: true });
      return d;
    };
    // A single producer instance visible to a consumer at `path` (producer's enclosing composites all enclose
    // the consumer). Loop-carried: if the exact instance isn't produced yet, fall back to the latest existing
    // sibling ≤ the current index (so a step reading a later co-step gets its previous-iteration output).
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
    // The collection of producer instances over the axes the consumer (`from`) has EXITED — one dir per branch
    // (exited parallel = map) and/or per iteration (exited loop = scan/history). Enumerates the exited levels.
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

    const snapshot = (cur: string): SavedState => ({ runId, current: cur, data, retries });
    const fail = (msg: string): "error" => { emit(msg); save(runDir, snapshot(current)); return "error"; };

    // ── ctx services (read c.runDir / c.signal per-call so branches/iterations get isolated runtime context) ──
    const resolveAppend = (append?: string): string | undefined => {
      if (!append) return undefined;
      const p = resolve(agentsDir, `${append}.md`);
      return existsSync(p) ? p : undefined;
    };

    async function callAgent(c: StateContext<C>, name: string, task: string, o?: any): Promise<void> {
      const sig = c.signal || signal;
      if (sig?.aborted) throw new Error("Aborted");
      const logFile = resolve(c.runDir, `${String(++stepCounter).padStart(2, "0")}-${name}.md`);
      const promptFile = resolve(agentsDir, `${name}.md`);
      if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);

      // Workspace wiring: the runtime owns every stage dir, so the agent never sees a hand-written path. It gets
      // its OWN instance dir plus the instances of the upstream producers visible to it (derived from the graph
      // by codegen: `inputs` = single, `inputLists` = a collection over exited parallel/loop axes), each with a
      // live listing. All resolved from the instance vector — producer-write and consumer-read can't drift.
      const lines = [`- your output directory (write all outputs here): ${c.out()}`];
      const lsLine = (d: string, indent = "") => { const f = existsSync(d) ? readdirSync(d) : []; return `${indent}${d}${f.length ? ` — files: ${f.join(", ")}` : " (empty)"}`; };
      for (const s of o?.inputs || []) lines.push(`- input from stage '${s}': ${lsLine(c.dir(s))}`);
      for (const b of o?.inputLists || []) {
        const dirs = c.dirs(b);
        lines.push(`- inputs from stage '${b}' (one dir per instance — branch and/or iteration)${dirs.length ? ":" : ": (none)"}`);
        for (const d of dirs) lines.push(lsLine(d, "    • "));
      }
      // Scalar ctx.data snapshot (counters like iteration / converged flags / counts). Agents can't read
      // ctx.data directly, so without this a contract referencing e.g. data.iteration sees nothing. Only
      // scalars are exposed (objects/arrays like data.branches stay out of the prompt to keep it small).
      const scalarData = Object.fromEntries(
        Object.entries(c.data as Record<string, unknown>).filter(([, v]) => v === null || typeof v !== "object"),
      );
      const dataLine = Object.keys(scalarData).length ? `\n\nState data (read-only scalars): ${JSON.stringify(scalarData)}` : "";
      const task2 = `${task}\n\nWorkspace (absolute paths — read and write only inside these directories):\n${lines.join("\n")}` +
        `\n\nConfig (CLI args, read-only): ${JSON.stringify(c.config)}${dataLine}`;

      await runAgent({
        prompt: promptFile, task: task2, cwd, onLine: emit, onStatus,
        logFile, piBinary, piModel: o?.model || piModel, signal: sig,
        validate: o?.validate, appendPrompt: resolveAppend(o?.append),
      });
      emit(`✓ ${name}`);
    }

    async function callInteractive(c: StateContext<C>, name: string, task: string, o?: any): Promise<void> {
      const sig = c.signal || signal;
      if (sig?.aborted) throw new Error("Aborted");
      const promptFile = resolve(agentsDir, `${name}.md`);
      if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);

      const artifacts = o?.artifacts || [];
      const absArtifacts = artifacts.map((a: string) => isAbsolute(a) ? a : resolve(cwd, a));
      for (let i = 0; i < absArtifacts.length; i++) {
        if (!existsSync(absArtifacts[i])) throw new Error(`Interactive artifact missing: ${artifacts[i]}`);
      }

      emit(`▷ ${name} (interactive — exit Pi to continue)`);
      await runInteractive({
        prompt: promptFile, task, cwd, piBinary, piModel: o?.model || piModel, signal: sig,
        appendPrompt: resolveAppend(o?.append),
      });

      for (let i = 0; i < absArtifacts.length; i++) {
        if (!existsSync(absArtifacts[i])) throw new Error(`Interactive contract violated: ${artifacts[i]} was deleted`);
        if (absArtifacts[i].endsWith(".xml")) {
          try { readFileSync(absArtifacts[i], "utf-8"); } catch (e: any) { throw new Error(`${artifacts[i]} unreadable: ${e.message}`); }
        }
      }
      emit(`✓ ${name}`);
    }

    function doShell(c: StateContext<C>, cmd: string, label?: string): boolean {
      const sig = c.signal || signal;
      if (sig?.aborted) return false;
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
    }

    function mkCtx(overrides: Partial<StateContext<C>> = {}): StateContext<C> {
      const c: StateContext<C> = {
        config: def.config,
        emit, status: onStatus, data, runId, runDir,
        signal,
        retry: (k) => (retries[k] = (retries[k] || 0) + 1),
        retries: (k) => retries[k] || 0,
        agent: async (n, t, o) => callAgent(c, n, t, o),
        interactive: async (n, t, o) => callInteractive(c, n, t, o),
        shell: (cmd, label) => doShell(c, cmd, label),
        ...overrides,
      } as StateContext<C>;
      // Workspace accessors over the instance vector (c.instancePath). c.out = this stage's own instance dir;
      // c.dir(s) = a single upstream producer's instance (shared scope; loop-carried-aware); c.dirs(s) = the
      // collection of a producer's instances over the axes this stage has exited (per-branch / per-iteration).
      const path = () => c.instancePath ?? [];
      c.out = () => instDir(c.stage!, path());
      c.dir = (stage: string) => singleDir(stage, path());
      c.dirs = (stage: string) => collectionDirs(stage, c.stage!, path());
      return c;
    }

    const ctx = mkCtx();

    /** Run `work` with a per-state timeout. Returns {timedOut: true} if the timer fires before completion. */
    async function withStateTimeout<T>(
      timeoutMs: number | undefined,
      work: (sig: AbortSignal | undefined) => Promise<T>,
    ): Promise<{ ok: T; timedOut: false } | { timedOut: true }> {
      if (!timeoutMs) return { ok: await work(signal), timedOut: false };

      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      if (signal?.aborted) ctrl.abort();
      else signal?.addEventListener("abort", onParentAbort, { once: true });

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
      try {
        const ok = await work(ctrl.signal);
        return { ok, timedOut: false };
      } catch (err: any) {
        if (timedOut) return { timedOut: true };
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
      }
    }

    // ── Nested-aware helpers (called from outer FSM loop and from executeStateOnce) ──

    async function runParallel(state: ParallelState<C>, name: string, base: StateContext<C>): Promise<BranchResult[]> {
      let items: any[];
      try { items = state.over(base); }
      catch (err: any) { throw new Error(`parallel "${name}" over: ${err.message}`); }
      if (!Array.isArray(items)) throw new Error(`parallel "${name}" over: expected array, got ${typeof items}`);

      const parallelDir = resolve(base.runDir, "parallel", name);
      mkdirSync(parallelDir, { recursive: true });

      const cap = Math.max(1, state.concurrency || items.length || 1);
      const results: BranchResult[] = new Array(items.length);
      let cursor = 0;
      emit(`▷ parallel ${name}: ${items.length} branch(es), concurrency=${Math.min(cap, items.length || 1)}`);

      async function runBranch(index: number): Promise<void> {
        if (signal?.aborted) {
          results[index] = { index, input: items[index], dir: "", ok: false, error: "Aborted" };
          return;
        }
        const branchDir = resolve(parallelDir, String(index)); // log/scope dir (NN-step logs live here)
        mkdirSync(branchDir, { recursive: true });
        const instancePath = [...(base.instancePath ?? []), index]; // extend the iteration vector by the branch axis
        const branchCtx = mkCtx({
          runDir: branchDir,
          branchInput: items[index],
          branchIndex: index,
          branchDir,
          instancePath,
        });
        // Output dir = the branch's instance dir under the global workspace — what consumers read via c.dirs.
        const outDir = instDir(state.branch, instancePath);
        try {
          await executeStateOnce(state.branch, branchCtx);
          results[index] = { index, input: items[index], dir: outDir, ok: true };
        } catch (err: any) {
          results[index] = { index, input: items[index], dir: outDir, ok: false, error: err.message };
          emit(`✗ branch ${index} (${state.branch}): ${err.message}`);
        }
      }

      async function worker(): Promise<void> {
        while (cursor < items.length) await runBranch(cursor++);
      }

      await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()));
      return results;
    }

    async function runLoop(state: LoopState<C>, name: string, base: StateContext<C>): Promise<number> {
      const steps = state.steps;
      const max = state.max;
      const exitFn = state.exit;
      const loopDir = resolve(base.runDir, "loop", name);
      mkdirSync(loopDir, { recursive: true });

      emit(`▷ loop ${name}: max=${max ?? "∞"}, steps=${steps.length}`);
      let iter = 0;
      while (true) {
        if (signal?.aborted) throw new Error("Aborted");
        data.iteration = iter;
        const iterDir = resolve(loopDir, String(iter));
        mkdirSync(iterDir, { recursive: true });
        const stepCtx = mkCtx({
          runDir: iterDir,
          branchInput: base.branchInput,
          branchIndex: base.branchIndex,
          branchDir: base.branchDir,
          instancePath: [...(base.instancePath ?? []), iter], // extend the iteration vector by this loop's iteration
        });

        for (const stepName of steps) await executeStateOnce(stepName, stepCtx);

        // Two DISTINCT iteration-space quantities (don't conflate them):
        //   data.iteration  = the COORDINATE — this iteration's 0-based index. Restored here because a nested
        //                     loop step may have overwritten the shared scalar with its own coordinate. `exit`
        //                     reads it as "the iteration that just ran", so it must be the index, not the count.
        //   <return value>  = the CARDINALITY — how many iterations ran. Surfaced by the caller as data.iterations.
        data.iteration = iter;
        const done = (exitFn && exitFn(base)) || (max !== undefined && iter + 1 >= max);
        iter++; // now iter == number of completed iterations (the cardinality)
        if (done) {
          emit(`✓ loop ${name}: ${iter} iteration(s)`);
          return iter;
        }
      }
    }

    /** Run an approval state in isolation. Returns the resolved event. */
    async function runApproval(state: ApprovalState<C>, name: string): Promise<string> {
      const round = (approvalRounds[name] = (approvalRounds[name] || 0) + 1);
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
        state: name, prompt: state.prompt, events, autoEvent, artifacts, round,
        priorFeedback: approvalFeedback[name] || [],
      };

      let resolution;
      if (opts.autoApprove) {
        emit(`⚠ auto-approve: ${name} → ${autoEvent}`);
        resolution = { event: autoEvent };
      } else if (opts.approvalHandler) {
        resolution = await opts.approvalHandler(checkpoint);
      } else {
        throw new Error(`approval "${name}" reached without --auto-approve or approvalHandler`);
      }

      if (!events.includes(resolution.event)) {
        throw new Error(`approval "${name}": invalid event "${resolution.event}" (allowed: ${events.join(", ")})`);
      }

      if (resolution.feedback?.trim()) {
        const dir = resolve(cwd, ".reharness", "feedback");
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, `${name}-round-${round}.md`), resolution.feedback);
        (approvalFeedback[name] ||= []).push(resolution.feedback);
      }
      return resolution.event;
    }

    async function runWait(state: WaitState<C>, name: string, isoCtx: StateContext<C>): Promise<string> {
      const checkAborted = () => { if (signal?.aborted) throw new Error("Aborted"); };
      const timeoutMs = state.timeoutMs;

      if (state.mode === "timer") {
        const ms = state.durationMs || 0;
        emit(`▷ wait ${name}: timer ${ms}ms`);
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, ms);
          signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("Aborted")); }, { once: true });
        });
        checkAborted();
        return "DONE";
      }

      if (state.mode === "file") {
        const fullPath = isAbsolute(state.path!) ? state.path! : resolve(cwd, state.path!);
        const interval = state.pollIntervalMs || 1000;
        emit(`▷ wait ${name}: file ${state.path} (poll ${interval}ms)`);
        const start = Date.now();
        while (true) {
          checkAborted();
          if (existsSync(fullPath)) return "DONE";
          if (timeoutMs && Date.now() - start > timeoutMs) return "TIMEOUT";
          await new Promise<void>(r => setTimeout(r, interval));
        }
      }

      if (state.mode === "shell") {
        emit(`▷ wait ${name}: shell ${state.command}`);
        return await new Promise<string>((res, rej) => {
          const proc = spawn("sh", ["-c", state.command!], { cwd, stdio: ["ignore", "inherit", "inherit"] });
          const onAbort = () => proc.kill("SIGTERM");
          signal?.addEventListener("abort", onAbort, { once: true });
          let timer: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          if (timeoutMs) timer = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, timeoutMs);
          proc.on("close", (code) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) rej(new Error("Aborted"));
            else if (timedOut) res("TIMEOUT");
            else res(code === 0 ? "DONE" : "ERROR");
          });
          proc.on("error", rej);
        });
      }

      if (state.mode === "webhook") {
        const port = state.port!;
        const path = state.path!;
        emit(`▷ wait ${name}: webhook :${port}${path}`);
        return await new Promise<string>((res, rej) => {
          const server = createServer((req, response) => {
            if (req.url !== path) { response.statusCode = 404; response.end(); return; }
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
              response.statusCode = 200; response.end("OK");
              isoCtx.data.webhookBody = body;
              isoCtx.data.webhookHeaders = req.headers;
              server.close(() => res("DONE"));
            });
          });
          server.on("error", rej);
          server.listen(port);
          const onAbort = () => server.close(() => rej(new Error("Aborted")));
          signal?.addEventListener("abort", onAbort, { once: true });
          if (timeoutMs) setTimeout(() => server.close(() => res("TIMEOUT")), timeoutMs);
        });
      }

      throw new Error(`Wait state '${name}' has unknown mode '${(state as any).mode}'`);
    }

    /** Execute a single state without following its on-transitions. Used by parallel.branch and loop.step. */
    async function executeStateOnce(name: string, isoCtx: StateContext<C>): Promise<void> {
      isoCtx.stage = name; // so c.out resolves to THIS stage's dir (per-branch when branchIndex is set)
      const state = def.states[name];
      if (!state) throw new Error(`Unknown state: ${name}`);
      if (isFinal(state)) throw new Error(`Cannot run final state '${name}' as a branch/step`);
      if (isSwitch(state)) throw new Error(`Cannot run switch state '${name}' as a branch/step (routing only)`);
      if (isApproval(state)) { await runApproval(state, name); return; }
      if (isParallel(state)) { isoCtx.data.branches = await runParallel(state, name, isoCtx); return; }
      if (isLoop(state)) { isoCtx.data.iterations = await runLoop(state, name, isoCtx); return; }
      if (isWait(state)) { isoCtx.data.waitEvent = await runWait(state, name, isoCtx); return; }
      // ActiveState (agent / code / set / interactive)
      await (state as ActiveState<C>).entry(isoCtx);
    }

    // ── Outer FSM loop ──
    let prevStateName = "";
    let prevStateStart = 0;
    while (true) {
      if (signal?.aborted) return fail("⚠ Aborted by user");

      const state = def.states[current];
      if (!state) return fail(`✗ Unknown state "${current}"`);

      save(runDir, snapshot(current));
      if (prevStateName) emit(`  └─ ${prevStateName} ${formatDuration(Date.now() - prevStateStart)}`);
      prevStateName = current;
      prevStateStart = Date.now();
      emit(`── ${current} ──`);

      if (isFinal(state)) {
        if (state.entry) {
          try { await state.entry(ctx as StateContext<any>); }
          catch (err: any) { emit(`⚠ final entry error: ${err.message}`); }
        }
        save(runDir, { ...snapshot(current), current: "__done__" });
        return state.status;
      }

      if (isApproval(state)) {
        const r = await withStateTimeout(state.timeoutMs, async () =>
          runApproval(state, current),
        );
        if (r.timedOut) {
          const tgt = state.on["TIMEOUT"];
          if (!tgt) return fail(`✗ approval "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(tgt, ctx);
          if (!next) return fail(`✗ approval "${current}" TIMEOUT: no resolvable target`);
          emit(`⚠ approval ${current} timed out → ${next}`);
          current = next;
          continue;
        }
        const next = resolveTarget(state.on[r.ok], ctx);
        if (!next) return fail(`✗ approval "${current}" → "${r.ok}": no resolvable target`);
        current = next;
        continue;
      }

      if (isSwitch(state)) {
        const next = resolveTarget(state.branches, ctx);
        if (!next) return fail(`✗ switch "${current}": no branch matched`);
        current = next;
        continue;
      }

      if (isParallel(state)) {
        const r = await withStateTimeout(state.timeoutMs, async (sig) =>
          runParallel(state, current, mkCtx({ signal: sig })),
        );
        if (r.timedOut) {
          if (!state.on?.["TIMEOUT"]) return fail(`✗ parallel "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(state.on["TIMEOUT"], ctx);
          if (!next) return fail(`✗ parallel "${current}" TIMEOUT: no target`);
          emit(`⚠ parallel ${current} timed out → ${next}`);
          current = next; continue;
        }
        data.branches = r.ok;
        const okCount = r.ok.filter(b => b.ok).length;
        emit(`✓ parallel ${current}: ${okCount}/${r.ok.length} ok`);
        if (signal?.aborted) return fail("⚠ Aborted by user");
        current = state.join;
        continue;
      }

      if (isLoop(state)) {
        const r = await withStateTimeout(state.timeoutMs, async (sig) =>
          runLoop(state, current, mkCtx({ signal: sig })),
        );
        if (r.timedOut) {
          if (!state.on?.["TIMEOUT"]) return fail(`✗ loop "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(state.on["TIMEOUT"], ctx);
          if (!next) return fail(`✗ loop "${current}" TIMEOUT: no target`);
          emit(`⚠ loop ${current} timed out → ${next}`);
          current = next; continue;
        }
        data.iterations = r.ok;
        if (signal?.aborted) return fail("⚠ Aborted by user");
        current = state.join;
        continue;
      }

      if (isWait(state)) {
        let event: string;
        try { event = await runWait(state, current, ctx); }
        catch (err: any) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          return fail(`✗ wait ${current}: ${err.message}`);
        }
        emit(`${event === "DONE" ? "✓" : "⚠"} wait ${current}: ${event}`);
        const target = state.on[event];
        if (!target) return fail(`✗ wait "${current}" event "${event}" has no transition`);
        const next = resolveTarget(target, ctx);
        if (!next) return fail(`✗ wait "${current}" event "${event}": no resolvable target`);
        current = next;
        continue;
      }

      // Call — invoke another skeleton's pipeline as a sub-execution.
      if (isCall(state)) {
        let subArgs: string[];
        try { subArgs = state.argsFn(ctx); }
        catch (err: any) { return fail(`✗ call "${current}" args: ${err.message}`); }
        if (!Array.isArray(subArgs)) return fail(`✗ call "${current}" args expression must return string[], got ${typeof subArgs}`);

        emit(`▷ call ${current} → ${state.skeleton}(${subArgs.map(a => JSON.stringify(a)).join(", ")})`);
        let subPipeline: Pipeline;
        try { subPipeline = state.callFactory(subArgs); }
        catch (err: any) { return fail(`✗ call "${current}": ${err.message}`); }

        const subEmit = (msg: string) => emit(`  [${state.skeleton}] ${msg}`);

        const r = await withStateTimeout(state.timeoutMs, async (sig) => subPipeline.run(subEmit, {
          signal: sig, onStatus, piModel,
          autoApprove: opts.autoApprove,
          approvalHandler: opts.approvalHandler,
        }));
        if (r.timedOut) {
          const tgt = state.on["TIMEOUT"];
          if (!tgt) return fail(`✗ call "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(tgt, ctx);
          if (!next) return fail(`✗ call "${current}" TIMEOUT: no target`);
          emit(`⚠ call ${current} timed out → ${next}`);
          current = next; continue;
        }
        const subStatus = r.ok;
        emit(`${subStatus === "success" ? "✓" : "✗"} call ${current}: ${subStatus}`);

        const target = state.on[subStatus];
        if (!target) return fail(`✗ call "${current}" status "${subStatus}" has no transition`);
        const next = resolveTarget(target, ctx);
        if (!next) return fail(`✗ call "${current}" status "${subStatus}": no resolvable target`);
        current = next;
        continue;
      }

      // Active
      const active = state as ActiveState<C>;
      const transitions: Record<string, TransitionTarget<C>> = typeof active.on === "string"
        ? { DONE: active.on } : active.on;

      let event: string;
      try {
        const r = await withStateTimeout(active.timeoutMs, async (sig) =>
          (await active.entry(mkCtx({ signal: sig, stage: current }))) || "DONE",
        );
        if (r.timedOut) {
          const tgt = transitions["TIMEOUT"];
          if (!tgt) return fail(`✗ ${current} timed out (no TIMEOUT transition)`);
          const next = resolveTarget(tgt, ctx);
          if (!next) return fail(`✗ ${current} TIMEOUT: no target`);
          emit(`⚠ ${current} timed out → ${next}`);
          current = next;
          continue;
        }
        event = r.ok;
      } catch (err: any) {
        if (signal?.aborted) return fail("⚠ Aborted by user");
        return fail(`✗ ${current} failed: ${err.message}`);
      }

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
