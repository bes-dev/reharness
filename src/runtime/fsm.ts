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

    const snapshot = (cur: string): SavedState => ({ runId, current: cur, data, retries });
    const fail = (msg: string): "error" => { emit(msg); save(runDir, snapshot(current)); return "error"; };

    // ── ctx services (read c.runDir per-call so branches/iterations get isolated logs) ──
    async function callAgent(c: StateContext<C>, name: string, task: string, o?: any): Promise<void> {
      if (signal?.aborted) throw new Error("Aborted");
      const logFile = resolve(c.runDir, `${String(++stepCounter).padStart(2, "0")}-${name}.md`);
      const promptFile = resolve(agentsDir, `${name}.md`);
      if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);
      await runAgent({
        prompt: promptFile, task, cwd, onLine: emit, onStatus,
        logFile, piBinary, piModel: o?.model || piModel, signal,
      });
      emit(`✓ ${name}`);
    }

    async function callInteractive(c: StateContext<C>, name: string, task: string, o?: any): Promise<void> {
      if (signal?.aborted) throw new Error("Aborted");
      const promptFile = resolve(agentsDir, `${name}.md`);
      if (!existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);

      const artifacts = o?.artifacts || [];
      const absArtifacts = artifacts.map((a: string) => isAbsolute(a) ? a : resolve(cwd, a));
      for (let i = 0; i < absArtifacts.length; i++) {
        if (!existsSync(absArtifacts[i])) throw new Error(`Interactive artifact missing: ${artifacts[i]}`);
      }

      emit(`▷ ${name} (interactive — exit Pi to continue)`);
      await runInteractive({
        prompt: promptFile, task, cwd, piBinary, piModel: o?.model || piModel, signal,
      });

      for (let i = 0; i < absArtifacts.length; i++) {
        if (!existsSync(absArtifacts[i])) throw new Error(`Interactive contract violated: ${artifacts[i]} was deleted`);
        if (absArtifacts[i].endsWith(".xml")) {
          try { readFileSync(absArtifacts[i], "utf-8"); } catch (e: any) { throw new Error(`${artifacts[i]} unreadable: ${e.message}`); }
        }
      }
      emit(`✓ ${name}`);
    }

    function doShell(_c: StateContext<C>, cmd: string, label?: string): boolean {
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
    }

    function mkCtx(overrides: Partial<StateContext<C>> = {}): StateContext<C> {
      const c: StateContext<C> = {
        config: def.config,
        emit, status: onStatus, data, runId, runDir,
        retry: (k) => (retries[k] = (retries[k] || 0) + 1),
        retries: (k) => retries[k] || 0,
        agent: async (n, t, o) => callAgent(c, n, t, o),
        interactive: async (n, t, o) => callInteractive(c, n, t, o),
        shell: (cmd, label) => doShell(c, cmd, label),
        ...overrides,
      } as StateContext<C>;
      return c;
    }

    const ctx = mkCtx();

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
        const branchDir = resolve(parallelDir, String(index));
        mkdirSync(branchDir, { recursive: true });
        const branchCtx = mkCtx({
          runDir: branchDir,
          branchInput: items[index],
          branchIndex: index,
          branchDir,
        });
        try {
          await executeStateOnce(state.branch, branchCtx);
          results[index] = { index, input: items[index], dir: branchDir, ok: true };
        } catch (err: any) {
          results[index] = { index, input: items[index], dir: branchDir, ok: false, error: err.message };
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
        });

        for (const stepName of steps) await executeStateOnce(stepName, stepCtx);

        iter++;
        data.iteration = iter; // re-establish in case nested loop overwrote it
        if ((exitFn && exitFn(base)) || (max !== undefined && iter >= max)) {
          emit(`✓ loop ${name}: ${iter} iteration(s)`);
          return iter;
        }
      }
    }

    /** Run an approval state in isolation. Returns the resolved event. */
    async function runApproval(state: ApprovalState<C>, name: string, base: StateContext<C>): Promise<string> {
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
        data.__allFeedback = approvalFeedback[name];
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
      const state = def.states[name];
      if (!state) throw new Error(`Unknown state: ${name}`);
      if (isFinal(state)) throw new Error(`Cannot run final state '${name}' as a branch/step`);
      if (isSwitch(state)) throw new Error(`Cannot run switch state '${name}' as a branch/step (routing only)`);
      if (isApproval(state)) { await runApproval(state, name, isoCtx); return; }
      if (isParallel(state)) { isoCtx.data.branches = await runParallel(state, name, isoCtx); return; }
      if (isLoop(state)) { isoCtx.data.iterations = await runLoop(state, name, isoCtx); return; }
      if (isWait(state)) { isoCtx.data.waitEvent = await runWait(state, name, isoCtx); return; }
      // ActiveState (agent / code / set / interactive)
      await (state as ActiveState<C>).entry(isoCtx);
    }

    // ── Outer FSM loop ──
    while (true) {
      if (signal?.aborted) return fail("⚠ Aborted by user");

      const state = def.states[current];
      if (!state) return fail(`✗ Unknown state "${current}"`);

      save(runDir, snapshot(current));
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
        let event: string;
        try { event = await runApproval(state, current, ctx); }
        catch (err: any) { return fail(`✗ ${err.message}`); }
        const next = resolveTarget(state.on[event], ctx);
        if (!next) return fail(`✗ approval "${current}" → "${event}": no resolvable target`);
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
        try {
          const results = await runParallel(state, current, ctx);
          data.branches = results;
          const okCount = results.filter(r => r.ok).length;
          emit(`✓ parallel ${current}: ${okCount}/${results.length} ok`);
          if (signal?.aborted) return fail("⚠ Aborted by user");
          current = state.join;
        } catch (err: any) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          return fail(`✗ parallel ${current}: ${err.message}`);
        }
        continue;
      }

      if (isLoop(state)) {
        try {
          data.iterations = await runLoop(state, current, ctx);
          if (signal?.aborted) return fail("⚠ Aborted by user");
          current = state.join;
        } catch (err: any) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          return fail(`✗ loop ${current}: ${err.message}`);
        }
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
        let subStatus: "success" | "error";
        try {
          subStatus = await subPipeline.run(subEmit, {
            signal, onStatus, piModel,
            autoApprove: opts.autoApprove,
            approvalHandler: opts.approvalHandler,
          });
        } catch (err: any) {
          if (signal?.aborted) return fail("⚠ Aborted by user");
          return fail(`✗ call "${current}" crashed: ${err.message}`);
        }
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
