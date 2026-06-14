import { spawn } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { resolve, isAbsolute, relative } from "path";
import { createServer } from "http";
import { TRACE_DIR } from "./trace.js";
import type {
  PipelineDefinition, StateContext, Pipeline, RunOptions, AgentOpts, InteractiveOpts,
  ActiveState, ApprovalState, ParallelState, LoopState, WaitState, TransitionTarget,
  ApprovalCheckpoint, BranchResult, ExecResult, ExecOptions,
} from "./types.js";
import { runAgent, runInteractive } from "./agent.js";
import { resolveProvider } from "./providers.js";
import { formatDuration } from "../term.js";
import { isFinal, isApproval, isSwitch, isParallel, isLoop, isCall, isWait } from "./state-guards.js";
import { type SavedState, save, load, findResumableRun, pruneRuns } from "./persistence.js";
import { makeWorkspace } from "./workspace.js";
import { validate } from "./validate.js";
import { redact } from "./redact.js";
import { SHELL_TIMEOUT_MS, POLL_MS, PROVIDER, RUN_RETENTION, AGENT_IDLE_MS, AGENT_MAX_MS, AGENT_MAX_USD, AGENT_MAX_TOKENS } from "../config.js";
import { layout } from "../layout.js";

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
 *  - Each `parallel` branch gets its OWN shallow copy of `ctx.data` (forked at the split), so concurrent branches
 *    — including nested composites (a branch that is itself a loop/parallel/wait, which makes the runtime write
 *    `data.iteration`/`data.iterations`/…) — never race on the scalar bus. A branch's `ctx.data` writes are
 *    branch-LOCAL: they do not propagate to the parent. Branches communicate through their isolated output dirs;
 *    the JOIN reads `data.branches` afterwards.
 *  - Resume is COARSE: only `current` + `data` are persisted, so resuming mid-composite re-runs that composite
 *    from the start (acceptable because composite steps are idempotent-by-design — they re-derive, not append).
 */

// ── Agent resource resolution ───────────────────────────────────

/** Load a leaf's optional `reharness/agents/<name>/harness.json` (the enhancement layer). Returns `{}` when
 *  absent or unparseable ⇒ Pi defaults. skills/extensions are paths relative to the agent's dir; resolved to
 *  absolute so Pi can load them. The base pipeline runs identically without any harness.json. A present-but-invalid
 *  harness.json still degrades to `{}` (never breaks the run), but invokes `onError` so the silent loss of a leaf's
 *  skills/model can be surfaced (the caller wires this to `c.warn` → ⚠ + the run verdict). */
export function loadHarness(agentsDir: string, name: string, onError?: (msg: string) => void): { model?: string; skills?: string[]; extensions?: string[] } {
  const p = resolve(agentsDir, name, "harness.json");
  if (!existsSync(p)) return {};
  try {
    const h = JSON.parse(readFileSync(p, "utf-8"));
    const rel = (xs?: string[]) => Array.isArray(xs) ? xs.map((x: string) => isAbsolute(x) ? x : resolve(agentsDir, name, x)) : undefined;
    return { model: typeof h.model === "string" ? h.model : undefined, skills: rel(h.skills), extensions: rel(h.extensions) };
  } catch (e: any) { onError?.(`harness.json for "${name}" is invalid (${e.message}) — ignoring it, using Pi defaults`); return {}; }
}

/** Resolve a leaf's prompt file. Prefers the harness dir layout `<name>/SYSTEM.md` (generated pipelines);
 *  falls back to a flat `<name>.md` (the `/generate` meta-pipeline and hand-written pipelines). */
export function resolvePrompt(agentsDir: string, name: string): string {
  const dir = resolve(agentsDir, name, "SYSTEM.md");
  if (existsSync(dir)) return dir;
  const flat = resolve(agentsDir, `${name}.md`);
  if (existsSync(flat)) return flat;
  throw new Error(`Agent prompt not found: ${dir} (or ${name}.md)`);
}

// ── Transition resolution ───────────────────────────────────────

function resolveTarget<C extends Record<string, any>>(t: TransitionTarget<C>, ctx: StateContext<C>): string | null {
  if (typeof t === "string") return t;
  const list = Array.isArray(t) ? t : [t];
  for (const g of list) if (!g.guard || g.guard(ctx)) return g.target;
  return null;
}

// ── Pipeline runner ─────────────────────────────────────────────

const newRunId = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export function definePipeline<C extends Record<string, any>>(def: PipelineDefinition<C>): Pipeline {
  validate(def);

  const cwd = def.cwd || process.cwd();
  const logsDir = def.logsDir || resolve(cwd, "logs");
  const agentsDir = def.agents
    ? (isAbsolute(def.agents) ? def.agents : resolve(cwd, def.agents))
    : layout(cwd).agents;

  async function run(emit: (msg: string) => void, opts: RunOptions = {}): Promise<"success" | "error"> {
    const signal = opts.signal;
    const onStatus = opts.onStatus || (() => {});
    const piModel = opts.piModel || def.piModel;
    const provider = resolveProvider(opts.provider || def.provider || PROVIDER);
    const piBinary = def.piBinary; // undefined ⇒ provider's default executable
    const dryRun = opts.dryRun;    // smoke mode: stub every agent/shell, exercise the graph without spending tokens

    const retries: Record<string, number> = {};
    const approvalRounds: Record<string, number> = {};
    const approvalFeedback: Record<string, string[]> = {};
    let data: Record<string, any> = { ...(opts.data || {}) };
    let current = def.initial;
    let stepCounter = 0;
    const warnings: { stage: string; message: string }[] = []; // c.warn → persisted in the verdict (degradations)
    const usage = { costUSD: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, agentRuns: 0 }; // actual LLM spend, summed per agent leaf (tokensIn = UNCACHED input; cacheRead/Write = the cached bulk)

    // Per-run hyperparameter overrides: a flat `state.knob → value` map (CLI `--param`). A knob read at its use
    // site falls back to the compiled value when unset. Validated up-front (fail-loud) so a bad override never
    // reaches the loop — in particular a loop `max` override stays a finite integer ≥1 (the termination invariant).
    const overrides = opts.overrides || {};
    const param = (st: string, knob: "max" | "concurrency" | "timeoutMs" | "idleMs" | "maxMs" | "maxUsd" | "maxTokens"): number | undefined => overrides[`${st}.${knob}`];
    for (const key of Object.keys(overrides)) {
      const dot = key.lastIndexOf(".");
      const st = dot > 0 ? (def.states as Record<string, any>)[key.slice(0, dot)] : undefined;
      const knob = key.slice(dot + 1), v = overrides[key];
      const bad =
        !st ? `no such state "${key.slice(0, dot)}"`
        : !["max", "concurrency", "timeoutMs", "idleMs", "maxMs", "maxUsd", "maxTokens"].includes(knob) ? `unknown knob "${knob}" (max | concurrency | timeoutMs | idleMs | maxMs | maxUsd | maxTokens)`
        : typeof v !== "number" || !Number.isFinite(v) || v <= 0 ? `must be a positive number, got ${v}`
        : knob === "max" && (st.type !== "loop" || !Number.isInteger(v)) ? `loop 'max' needs an integer ≥1 on a loop state`
        : knob === "concurrency" && (st.type !== "parallel" || !Number.isInteger(v)) ? `'concurrency' needs an integer ≥1 on a parallel state`
        : "";
      if (bad) { emit(`✗ invalid --param ${key}: ${bad}`); return "error"; }
    }

    let runId: string, runDir: string;
    if (opts.resume) {
      const latest = findResumableRun(logsDir);
      const saved = latest ? load(latest) : null;
      if (latest && saved) {
        runId = saved.runId; runDir = latest;
        current = saved.current;
        Object.assign(data, saved.data);
        Object.assign(retries, saved.retries);
        if (saved.usage) Object.assign(usage, saved.usage); // keep pre-resume cost (observed, not estimated) in the final verdict
        emit(`Resuming from ${current} (run ${runId})`);
      } else {
        // --resume was asked but there's nothing to resume — announce it (don't silently behave like a fresh run, so
        // a typo'd command / an already-completed / an unreadable run is visible). (A state.json corrupt mid-write is
        // skipped by findResumableRun and surfaces here too; distinguishing corrupt-vs-absent is post-1.0.)
        emit(`⚠ --resume: no interrupted run found in ${relative(cwd, logsDir)} — starting a fresh run`);
        runId = newRunId(); runDir = resolve(logsDir, `run-${runId}`);
      }
    } else {
      runId = newRunId(); runDir = resolve(logsDir, `run-${runId}`);
    }
    pruneRuns(logsDir, RUN_RETENTION); // bound disk growth — keep the newest N runs (this one is newest, so kept)
    mkdirSync(runDir, { recursive: true });
    if (dryRun) emit("◇ dry-run: agents & c.shell stubbed — smoke-testing routing & data-flow, no tokens (a code state that spawns a subprocess directly still runs)");

    // Instance-vector workspace addressing (the polyhedral iteration-space model) — see workspace.ts. c.out =
    // this stage's instance dir; c.dir(s) = an upstream producer's instance; c.dirs(s) = a producer's collection.
    const workRoot = resolve(runDir, "work");
    const { instDir, singleDir, collectionDirs } = makeWorkspace(workRoot, def.states);

    const snapshot = (cur: string): SavedState => ({ runId, current: cur, data, retries });
    const fail = (msg: string): "error" => { emit(msg); save(runDir, snapshot(current)); return "error"; };

    // ── ctx services (read c.runDir / c.signal per-call so branches/iterations get isolated runtime context) ──
    const resolveAppend = (append?: string): string | undefined => {
      if (!append) return undefined;
      const p = resolve(agentsDir, `${append}.md`);
      return existsSync(p) ? p : undefined;
    };

    async function callAgent(c: StateContext<C>, name: string, task: string, o?: AgentOpts): Promise<void> {
      const sig = c.signal || signal;
      if (sig?.aborted) throw new Error("Aborted");
      if (dryRun) { // stub: drop a placeholder so downstream producers see a non-empty dir; exercise routing/data-flow, no spawn
        mkdirSync(c.out(), { recursive: true });
        writeFileSync(resolve(c.out(), `${name}.dryrun.md`), `# (dry-run stub) ${name}\n\n${task}\n`);
        emit(`◇ ${name} (dry-run — agent stubbed)`);
        return;
      }
      // Trace mirrors the artifact tree: <run>/trace/<stage>/<i…>/NN-stage.md alongside work/<stage>/<i…>/.
      const traceDir = resolve(runDir, TRACE_DIR, relative(workRoot, c.out()));
      mkdirSync(traceDir, { recursive: true });
      const logFile = resolve(traceDir, `${String(++stepCounter).padStart(2, "0")}-${name}.md`);
      const promptFile = resolvePrompt(agentsDir, name);

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

      // Per-leaf harness: an optional reharness/agents/<name>/harness.json (the enhancement layer). Absent ⇒
      // Pi defaults. Read here so harness stays a layer the runtime resolves, not something codegen bakes in.
      // Merge with opts (a caller — e.g. the enhance stage — may also pass capabilities programmatically).
      const harness = loadHarness(agentsDir, name, c.warn);
      const merge = (a?: string[], b?: string[]) => { const m = [...(a ?? []), ...(b ?? [])]; return m.length ? m : undefined; };

      // Per-leaf watchdog (the two-timer model): a `--param <name>.<knob>` override wins, else the caller's opts,
      // else the global env default; 0 ⇒ undefined (disabled). idleMs waits on a working leaf; maxMs/maxUsd/maxTokens
      // are the non-extendable ceilings.
      const knob = (k: "idleMs" | "maxMs" | "maxUsd" | "maxTokens", def: number) => (param(name, k) ?? o?.[k] ?? def) || undefined;
      await runAgent({
        prompt: promptFile, task: task2, cwd, onLine: emit, onStatus, provider,
        logFile, piBinary, piModel: harness.model || o?.model || piModel, signal: sig,
        validate: o?.validate, appendPrompt: resolveAppend(o?.append),
        skills: merge(harness.skills, o?.skills), extensions: merge(harness.extensions, o?.extensions),
        idleMs: knob("idleMs", AGENT_IDLE_MS), maxMs: knob("maxMs", AGENT_MAX_MS),
        maxUsd: knob("maxUsd", AGENT_MAX_USD), maxTokens: knob("maxTokens", AGENT_MAX_TOKENS),
        onUsage: (u) => { usage.costUSD += u.costUSD; usage.tokensIn += u.tokensIn; usage.tokensOut += u.tokensOut; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite; usage.agentRuns += 1; },
      });
      emit(`✓ ${name}`);
    }

    async function callInteractive(c: StateContext<C>, name: string, task: string, o?: InteractiveOpts): Promise<void> {
      const sig = c.signal || signal;
      if (sig?.aborted) throw new Error("Aborted");
      if (dryRun) { emit(`◇ ${name} (dry-run — interactive skipped)`); return; }
      const promptFile = resolvePrompt(agentsDir, name);

      const artifacts = o?.artifacts || [];
      const absArtifacts = artifacts.map((a: string) => isAbsolute(a) ? a : resolve(cwd, a));
      for (let i = 0; i < absArtifacts.length; i++) {
        if (!existsSync(absArtifacts[i])) throw new Error(`Interactive artifact missing: ${artifacts[i]}`);
      }

      emit(`▷ ${name} (interactive — exit the backend to continue)`);
      await runInteractive({
        prompt: promptFile, task, cwd, piBinary, piModel: o?.model || piModel, signal: sig, provider,
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

    function doShell(c: StateContext<C>, cmd: string, label?: string): Promise<boolean> {
      const sig = c.signal || signal;
      const lbl = redact(label || cmd.slice(0, 30)); // a label defaults to the command — which may carry a token
      if (dryRun) { emit(`◇ shell (dry-run): ${lbl}`); return Promise.resolve(true); } // stub success, no spawn
      return new Promise<boolean>((resolve) => {
        if (sig?.aborted) { resolve(false); return; }
        let done = false;
        const settle = (ok: boolean, tail?: string) => {
          if (done) return;
          done = true;
          emit(ok ? `✓ ${lbl}` : `✗ ${lbl}`);
          if (!ok && tail) tail.trim().split("\n").slice(-5).filter(Boolean).forEach((l) => emit(redact(`  ${l}`)));
          resolve(ok);
        };
        // spawn (async, non-blocking) is why c.shell is async: a per-state/composite timeout timer AND a run-level
        // AbortSignal can fire mid-command. `signal` kills the child on abort/timeout (the state then routes
        // TIMEOUT / aborts); `timeout` is the hard backstop. A synchronous execSync would block the event loop and
        // defeat both — the abort callback and the FSM timer could never run until the command finished.
        const proc = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"],
          signal: sig, timeout: SHELL_TIMEOUT_MS, killSignal: "SIGKILL" });
        let out = "", err = "";
        proc.stdout?.on("data", (d) => { out += d; });
        proc.stderr?.on("data", (d) => { err += d; });
        proc.on("error", (e: any) => settle(false, e?.message)); // spawn failure, or killed by abort/timeout
        proc.on("close", (code) => settle(code === 0, err || out));
      });
    }

    // Like doShell but RETURNS the subprocess result (argv form, no shell) — for code states that need stdout / exit
    // code. Same async/abortable/timeout-bounded guarantees, and dry-run-aware: stubbed so smoke runs never spawn.
    function doExec(c: StateContext<C>, cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
      const sig = c.signal || signal;
      const lbl = redact([cmd, ...args].join(" ").slice(0, 60));
      if (dryRun) { emit(`◇ exec (dry-run): ${lbl}`); return Promise.resolve({ ok: true, status: 0, stdout: "", stderr: "" }); }
      return new Promise<ExecResult>((resolve) => {
        if (sig?.aborted) { resolve({ ok: false, status: null, stdout: "", stderr: "aborted" }); return; }
        let done = false;
        let out = "", err = "";
        const settle = (status: number | null, errMsg?: string) => {
          if (done) return;
          done = true;
          const ok = status === 0;
          emit(ok ? `✓ ${lbl}` : `✗ ${lbl}`);
          resolve({ ok, status, stdout: out, stderr: errMsg && !err ? errMsg : err });
        };
        const proc = spawn(cmd, args, { cwd: opts.cwd ?? cwd, stdio: ["pipe", "pipe", "pipe"],
          signal: sig, timeout: opts.timeoutMs ?? SHELL_TIMEOUT_MS, killSignal: "SIGKILL" });
        proc.stdout?.on("data", (d) => { out += d; });
        proc.stderr?.on("data", (d) => { err += d; });
        proc.on("error", (e: any) => settle(null, e?.message)); // spawn failure, or killed by abort/timeout
        proc.on("close", (code) => settle(code));
        if (opts.input !== undefined) { proc.stdin?.write(opts.input); proc.stdin?.end(); }
      });
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
        exec: (cmd, args, opts) => doExec(c, cmd, args, opts),
        warn: (msg) => { warnings.push({ stage: c.stage ?? "?", message: msg }); emit(`⚠ ${msg}`); },
        ...overrides,
      } as StateContext<C>;
      // Workspace accessors over the instance vector (c.instancePath). c.out = this stage's own instance dir;
      // c.dir(s) = a single upstream producer's instance (shared scope; loop-carried-aware); c.dirs(s) = the
      // collection of a producer's instances over the axes this stage has exited (per-branch / per-iteration).
      const path = () => c.instancePath ?? [];
      // Workspace is ENTRY-ONLY: a stage is bound only while its entry/branch/step runs (executeStateOnce sets
      // c.stage). Guards and exit actions run at a transition point with no stage and must read the scalar bus
      // (data/config/retries), per the routing invariant — so fail loud (not a cryptic undefined) if they don't.
      const entryOnly = (m: string): string => {
        if (!c.stage) throw new Error(`c.${m}() is entry-only — guards and exit actions read ctx.data/config/retries, not the workspace`);
        return c.stage;
      };
      c.out = () => instDir(entryOnly("out"), path());
      c.dir = (stage: string) => { entryOnly("dir"); return singleDir(stage, path()); };
      c.dirs = (stage: string) => collectionDirs(stage, entryOnly("dirs"), path());
      return c;
    }

    const ctx = mkCtx();

    /** Run `work` with a per-state timeout. Returns {timedOut: true} if the timer fires before completion. */
    async function withStateTimeout<T>(
      timeoutMs: number | undefined,
      work: (sig: AbortSignal | undefined) => Promise<T>,
      parentSignal: AbortSignal | undefined = signal, // signal this timeout chains onto (default: the run signal;
    ): Promise<{ ok: T; timedOut: false } | { timedOut: true }> { // a branch/step passes its composite's signal)
      if (!timeoutMs) return { ok: await work(parentSignal), timedOut: false };

      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      if (parentSignal?.aborted) ctrl.abort();
      else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
      try {
        const ok = await work(ctrl.signal);
        // If the timer fired but `work` resolved anyway (it honored the abort and unwound without throwing —
        // e.g. a composite whose branches were aborted yet still returned results), the timeout is authoritative.
        if (timedOut) return { timedOut: true };
        return { ok, timedOut: false };
      } catch (err: any) {
        if (timedOut) return { timedOut: true };
        throw err;
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    }

    // ── Nested-aware helpers (called from outer FSM loop and from executeStateOnce) ──

    async function runParallel(state: ParallelState<C>, name: string, base: StateContext<C>): Promise<BranchResult[]> {
      let items: any[];
      try { items = state.over(base); }
      catch (err: any) { throw new Error(`parallel "${name}" over: ${err.message}`); }
      if (!Array.isArray(items)) throw new Error(`parallel "${name}" over: expected array, got ${typeof items}`);

      const cap = Math.max(1, (param(name, "concurrency") ?? state.concurrency) || items.length || 1);
      const results: BranchResult[] = new Array(items.length);
      let cursor = 0;
      emit(`▷ parallel ${name}: ${items.length} branch(es), concurrency=${Math.min(cap, items.length || 1)}`);

      const sig = base.signal; // the timeout/parent-abort signal threaded in by withStateTimeout — NOT the run-level closure
      async function runBranch(index: number): Promise<void> {
        if (sig?.aborted) {
          results[index] = { index, input: items[index], dir: "", ok: false, error: "Aborted" };
          return;
        }
        const instancePath = [...(base.instancePath ?? []), index]; // extend the iteration vector by the branch axis
        const branchCtx = mkCtx({
          signal: sig, // so a per-state timeout (or user abort) actually reaches the branch's agent/code leaves
          branchInput: items[index],
          branchIndex: index,
          instancePath,
          // Fork the scalar data bus: each branch gets its OWN shallow copy, so concurrent branches — including
          // nested composites that make the runtime write data.iteration/iterations/… — never race. Branch writes
          // are branch-local (don't propagate to the parent); the join reads results from `data.branches`/dirs.
          data: { ...base.data },
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
      const max = param(name, "max") ?? state.max;
      const exitFn = state.exit;

      emit(`▷ loop ${name}: max=${max ?? "∞"}, steps=${steps.length}`);
      // Operate on the CONTEXT's data, not the run-level closure: for a top-level loop that IS the shared data,
      // but for a loop nested under a parallel it is that branch's isolated copy — so sibling branches' loops
      // don't clobber each other's data.iteration.
      const data = base.data;
      const sig = base.signal; // the timeout/parent-abort signal threaded in by withStateTimeout — NOT the run-level closure
      let iter = 0;
      while (true) {
        if (sig?.aborted) throw new Error("Aborted");
        data.iteration = iter;
        const stepCtx = mkCtx({
          signal: sig, // so a per-state timeout (or user abort) actually reaches the loop's step leaves
          branchInput: base.branchInput,
          branchIndex: base.branchIndex,
          instancePath: [...(base.instancePath ?? []), iter], // extend the iteration vector by this loop's iteration
          data, // steps share THIS loop's data namespace (the branch-isolated copy when nested under a parallel)
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
        const dir = layout(cwd).feedback;
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, `${name}-round-${round}.md`), resolution.feedback);
        (approvalFeedback[name] ||= []).push(resolution.feedback);
      }
      return resolution.event;
    }

    async function runWait(state: WaitState<C>, name: string, isoCtx: StateContext<C>): Promise<string> {
      const checkAborted = () => { if (signal?.aborted) throw new Error("Aborted"); };
      const timeoutMs = param(name, "timeoutMs") ?? state.timeoutMs;

      if (state.mode === "timer") {
        const ms = state.durationMs || 0;
        emit(`▷ wait ${name}: timer ${ms}ms`);
        await new Promise<void>((res, rej) => {
          let t: ReturnType<typeof setTimeout>;
          const onAbort = () => { clearTimeout(t); rej(new Error("Aborted")); };
          t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms); // remove the listener on normal completion (no leak across loop iterations)
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        checkAborted();
        return "DONE";
      }

      if (state.mode === "file") {
        const fullPath = isAbsolute(state.path!) ? state.path! : resolve(cwd, state.path!);
        const interval = state.pollIntervalMs || POLL_MS;
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
          const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
          proc.on("close", (code) => {
            cleanup();
            if (signal?.aborted) rej(new Error("Aborted"));
            else if (timedOut) res("TIMEOUT");
            else res(code === 0 ? "DONE" : "ERROR");
          });
          proc.on("error", (e) => { cleanup(); rej(e); }); // spawn failure: clear timer + listener (close may never fire)
        });
      }

      if (state.mode === "webhook") {
        const port = state.port!;
        const path = state.path!;
        emit(`▷ wait ${name}: webhook :${port}${path}`);
        return await new Promise<string>((res, rej) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const server = createServer((req, response) => {
            if (req.url !== path) { response.statusCode = 404; response.end(); return; }
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
              response.statusCode = 200; response.end("OK");
              isoCtx.data.webhookBody = body;
              isoCtx.data.webhookHeaders = req.headers;
              finish(() => res("DONE"));
            });
          });
          // Settle exactly once: clear the timeout + abort listener and close the server, THEN resolve/reject.
          // (Without this the timeout timer outlived a successful request — a dangling timer that kept the event
          // loop alive and fired a no-op server.close on the already-closed server.)
          const finish = (settle: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            server.close(() => settle());
          };
          const onAbort = () => finish(() => rej(new Error("Aborted")));
          server.on("error", (e) => finish(() => rej(e)));
          server.listen(port);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (timeoutMs) timer = setTimeout(() => finish(() => res("TIMEOUT")), timeoutMs);
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
      // ActiveState (agent / code / set / interactive).
      const active = state as ActiveState<C>;
      // No own timeout (the common case): run directly under the composite's signal already in isoCtx.signal —
      // no extra wrapping, no mutation.
      const timeoutMs = param(name, "timeoutMs") ?? active.timeoutMs;
      if (timeoutMs === undefined) { await active.entry(isoCtx); return; }
      // Own timeout: chain a fresh timeout onto the composite's signal (so the container timeout still applies too)
      // and hand the entry the tighter signal. isoCtx is THIS branch/step's own context (one per branch index /
      // loop iteration), never shared, so writing its signal here is local — no cross-branch leak. On the own
      // timeout the entry is aborted and we throw — a parallel branch is then marked failed, a loop step aborts it.
      const r = await withStateTimeout(timeoutMs, async (sig) => { isoCtx.signal = sig; await active.entry(isoCtx); }, isoCtx.signal);
      if (r.timedOut) throw new Error(`'${name}' timed out after ${timeoutMs}ms`);
    }

    // ── Outer FSM loop ──
    let prevStateName = "";
    let prevStateStart = 0;
    while (true) {
      if (signal?.aborted) return fail("⚠ Aborted by user");

      const state = def.states[current];
      if (!state) return fail(`✗ Unknown state "${current}"`);

      save(runDir, snapshot(current));
      const cameFrom = prevStateName; // the stage we transitioned FROM (= the failing stage at an error terminal)
      if (prevStateName) emit(`  └─ ${prevStateName} ${formatDuration(Date.now() - prevStateStart)}`);
      prevStateName = current;
      prevStateStart = Date.now();
      emit(`── ${current} ──`);

      if (isFinal(state)) {
        if (state.entry) {
          try { await state.entry(ctx as StateContext<any>); }
          catch (err: any) { emit(`⚠ final entry error: ${err.message}`); }
        }
        // Fail-loud at the user boundary: an error terminal must announce WHY. ctx.data.error is the
        // convention every code state uses for a human-readable reason; surface it (and where the logs are)
        // instead of stopping with only the bare status the CLI prints.
        if (state.status === "error" && !dryRun) { // in dry-run an error terminal is expected (stubs ≠ real artifacts)
          const reason = typeof data.error === "string" ? data.error : "";
          emit(reason ? `✗ failed: ${reason}` : `✗ failed (no reason set in ctx.data.error)`);
          emit(`  run dir: ${runDir}`);
        }
        // Surface the run's actual LLM spend (0 for a fully-deterministic pipeline — the amortization signal).
        // Total = ALL tokens the model processed (uncached in + out + cache read + cache write) — the true work,
        // not just uncached input (which alone undercounts ~30× under prompt caching). Cost is the cache-discounted $.
        const tk = usage.tokensIn + usage.tokensOut + usage.cacheRead + usage.cacheWrite;
        const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : `${n}`;
        const cache = usage.cacheRead + usage.cacheWrite;
        emit(`runtime: ${usage.agentRuns} agent run(s) · ${fmt(tk)} tokens (out ${fmt(usage.tokensOut)}${cache ? `, cached ${fmt(cache)}` : ""}) · $${usage.costUSD.toFixed(4)}`);
        // Persist the verdict so `evolve` can read it from disk (current is about to become "__done__").
        const argv = Array.isArray((def.config as any).__argv) ? (def.config as any).__argv as string[] : undefined;
        save(runDir, { ...snapshot(current), current: "__done__", status: state.status, failedStage: state.status === "error" ? cameFrom : undefined, argv, warnings: warnings.length ? warnings : undefined, usage });
        // Smoke mode: reaching ANY terminal means the graph is traversable end-to-end (a stubbed agent can't satisfy
        // a code state's content contract, so an `error` terminal is EXPECTED). Only a crash / dead-end (fail-loud δ,
        // below) is a real defect — so dry-run reports success here and names the terminal it landed on.
        if (dryRun) { emit(`◇ dry-run: graph traversed to terminal '${current}' (status ${state.status}) — no crash / dead-end`); return "success"; }
        return state.status;
      }

      if (isApproval(state)) {
        const r = await withStateTimeout(param(current, "timeoutMs") ?? state.timeoutMs, async () =>
          runApproval(state, current),
        );
        if (r.timedOut) {
          const tgt = state.on["TIMEOUT"];
          if (!tgt) return fail(`✗ approval "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(tgt, ctx);
          if (!next) return fail(`✗ approval "${current}" TIMEOUT: no resolvable target`);
          warnings.push({ stage: current, message: `timed out → routed to ${next} (correction may be incomplete)` });
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
        let r: { ok: BranchResult[]; timedOut: false } | { timedOut: true };
        try {
          r = await withStateTimeout(param(current, "timeoutMs") ?? state.timeoutMs, async (sig) =>
            runParallel(state, current, mkCtx({ signal: sig })),
          );
        } catch (err: any) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          return fail(`✗ parallel ${current}: ${err.message}`);
        }
        if (r.timedOut) {
          if (!state.on?.["TIMEOUT"]) return fail(`✗ parallel "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(state.on["TIMEOUT"], ctx);
          if (!next) return fail(`✗ parallel "${current}" TIMEOUT: no target`);
          warnings.push({ stage: current, message: `timed out → routed to ${next} (correction may be incomplete)` });
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
        let r: { ok: number; timedOut: false } | { timedOut: true };
        try {
          r = await withStateTimeout(param(current, "timeoutMs") ?? state.timeoutMs, async (sig) =>
            runLoop(state, current, mkCtx({ signal: sig })),
          );
        } catch (err: any) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          return fail(`✗ loop ${current}: ${err.message}`);
        }
        if (r.timedOut) {
          if (!state.on?.["TIMEOUT"]) return fail(`✗ loop "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(state.on["TIMEOUT"], ctx);
          if (!next) return fail(`✗ loop "${current}" TIMEOUT: no target`);
          warnings.push({ stage: current, message: `timed out → routed to ${next} (correction may be incomplete)` });
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

        const r = await withStateTimeout(param(current, "timeoutMs") ?? state.timeoutMs, async (sig) => subPipeline.run(subEmit, {
          signal: sig, onStatus, piModel,
          autoApprove: opts.autoApprove,
          approvalHandler: opts.approvalHandler,
        }));
        if (r.timedOut) {
          const tgt = state.on["TIMEOUT"];
          if (!tgt) return fail(`✗ call "${current}" timed out (no TIMEOUT transition)`);
          const next = resolveTarget(tgt, ctx);
          if (!next) return fail(`✗ call "${current}" TIMEOUT: no target`);
          warnings.push({ stage: current, message: `timed out → routed to ${next} (correction may be incomplete)` });
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
        const r = await withStateTimeout(param(current, "timeoutMs") ?? active.timeoutMs, async (sig) =>
          (await active.entry(mkCtx({ signal: sig, stage: current }))) || "DONE",
        );
        if (r.timedOut) {
          const tgt = transitions["TIMEOUT"];
          if (!tgt) return fail(`✗ ${current} timed out (no TIMEOUT transition)`);
          const next = resolveTarget(tgt, ctx);
          if (!next) return fail(`✗ ${current} TIMEOUT: no target`);
          warnings.push({ stage: current, message: `timed out → routed to ${next} (correction may be incomplete)` });
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
