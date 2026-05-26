import { compileGuardExpr } from "./expr.js";

/** State types allowed as a `parallel` branch. Excludes routing-only (switch/check), terminal (final),
 * interactive (terminal contention), and approval (parallel terminal contention). */
const BRANCH_ALLOWED = new Set<SkeletonState["type"]>(["agent", "code", "set", "parallel", "loop"]);

/** State types allowed as a `loop` step. Same as branches, plus approval (loop is sequential — no contention). */
const STEP_ALLOWED = new Set<SkeletonState["type"]>(["agent", "code", "set", "approval", "parallel", "loop"]);

export interface GuardedTransition {
  target: string;
  /** Either `retries:KEY<N` (retry counter) OR a `expr:<safe-subset-JS>` expression. Empty → unconditional. */
  guard?: string;
}

export interface DataAssignment {
  key: string;
  /** Expression in the same safe-subset language as guards. */
  value: string;
}

export type WaitMode = "timer" | "file" | "shell" | "webhook";

export interface SkeletonState {
  type: "agent" | "interactive" | "code" | "approval" | "switch" | "set" | "parallel" | "loop" | "call" | "wait" | "final";
  status?: "success" | "error";
  on?: Record<string, string | GuardedTransition[]>;
  /** Approval only: prompt text shown at the checkpoint. */
  prompt?: string;
  /** Approval / interactive only: file paths to display / edit. */
  artifacts?: string[];
  /** Approval only: event used by auto-approve mode. */
  autoEvent?: string;
  /** Switch only: ordered branches, first guard true wins. */
  branches?: GuardedTransition[];
  /** Set only: data writes performed on entry, before transitioning. */
  dataAssignments?: DataAssignment[];
  /** Parallel only: expression returning the array to fan out over. */
  overExpr?: string;
  /** Parallel only: state name to invoke per item. */
  parallelBranch?: string;
  /** Parallel / loop: state to transition to after the construct completes. */
  parallelJoin?: string;
  /** Parallel only: max concurrent branches (optional cap). */
  concurrency?: number;
  /** Loop only: ordered list of state names to run per iteration. */
  loopSteps?: string[];
  /** Loop only: hard iteration cap (safety). At least one of maxIterations/exitExpr required. */
  maxIterations?: number;
  /** Loop only: expression evaluated after each iteration; truthy → exit to join. */
  exitExpr?: string;
  /** Call only: skeleton id to invoke as a sub-pipeline. */
  callSkeleton?: string;
  /** Call only: expression returning string[] of CLI args for the sub-pipeline. */
  callArgsExpr?: string;
  /** Wait only. */
  waitMode?: WaitMode;
  /** Wait timer/file/shell/webhook: duration (e.g. "30s") or absolute timeout. */
  waitDuration?: string;
  waitTimeout?: string;
  /** Wait file: path to watch. Wait webhook: HTTP URL path (e.g. "/cb"). */
  waitPath?: string;
  /** Wait shell: command line. */
  waitCommand?: string;
  /** Wait webhook: TCP port. */
  waitPort?: number;
  /** Wait file: poll interval (default "1s"). */
  waitPollInterval?: string;
}

export interface Skeleton {
  id: string;
  description: string;
  usage: string;
  initial: string;
  formatVersion?: string;
  states: Record<string, SkeletonState>;
}

export function validateSkeleton(sk: Skeleton): string[] {
  const errors: string[] = [];
  const names = new Set(Object.keys(sk.states));

  if (!sk.id) errors.push("Missing 'id'");
  if (!sk.description) errors.push("Missing 'description'");
  if (!sk.usage) errors.push("Missing 'usage'");
  if (!sk.initial) errors.push("Missing 'initial'");
  if (sk.initial && !names.has(sk.initial)) errors.push(`Initial state '${sk.initial}' does not exist`);

  let hasFinal = false;
  for (const [name, state] of Object.entries(sk.states)) {
    if (state.type === "final") {
      hasFinal = true;
      if (!state.status) errors.push(`Final state '${name}' missing 'status'`);
      continue;
    }

    if (state.type === "switch") {
      if (!state.branches || state.branches.length === 0) {
        errors.push(`Switch state '${name}' must declare at least one <go>`);
      } else {
        for (const gt of state.branches) {
          if (!names.has(gt.target)) errors.push(`Switch '${name}' → '${gt.target}' does not exist`);
          validateGuard(name, gt.guard, errors);
        }
      }
      continue;
    }

    if (state.type === "set") {
      if (!state.dataAssignments || state.dataAssignments.length === 0) {
        errors.push(`Set state '${name}' must declare at least one <data key=... value=.../>`);
      } else {
        for (const a of state.dataAssignments) {
          if (!a.key) errors.push(`Set state '${name}' has <data> without key`);
          try { compileGuardExpr(a.value); }
          catch (e: any) { errors.push(`Set state '${name}' data '${a.key}' value: ${e.message}`); }
        }
      }
    }

    if (state.type === "loop") {
      if (!state.loopSteps || state.loopSteps.length === 0) {
        errors.push(`Loop state '${name}' must declare at least one <step state=.../>`);
      } else {
        for (const s of state.loopSteps) {
          if (!names.has(s)) errors.push(`Loop state '${name}' step '${s}' does not exist`);
          else {
            const st = sk.states[s].type;
            if (!STEP_ALLOWED.has(st)) {
              errors.push(`Loop state '${name}' step '${s}' must be one of [${[...STEP_ALLOWED].join(", ")}], got ${st}`);
            }
          }
        }
      }
      if (!state.parallelJoin) errors.push(`Loop state '${name}' missing 'join' attribute`);
      else if (!names.has(state.parallelJoin)) errors.push(`Loop state '${name}' join '${state.parallelJoin}' does not exist`);
      if (!state.maxIterations && !state.exitExpr) {
        errors.push(`Loop state '${name}' needs at least one of 'max' or 'exit' attributes (to terminate)`);
      }
      if (state.maxIterations !== undefined && (!Number.isInteger(state.maxIterations) || state.maxIterations < 1)) {
        errors.push(`Loop state '${name}' max must be a positive integer`);
      }
      if (state.exitExpr) {
        try { compileGuardExpr(state.exitExpr); }
        catch (e: any) { errors.push(`Loop state '${name}' exit expr invalid: ${e.message}`); }
      }
      continue;
    }

    if (state.type === "wait") {
      const mode = state.waitMode;
      if (!mode) errors.push(`Wait state '${name}' missing 'mode' attribute`);
      else if (!["timer", "file", "shell", "webhook"].includes(mode)) {
        errors.push(`Wait state '${name}' invalid mode '${mode}' (expected timer|file|shell|webhook)`);
      } else {
        if (mode === "timer" && !state.waitDuration) errors.push(`Wait '${name}' mode=timer needs 'duration'`);
        if (mode === "file" && !state.waitPath) errors.push(`Wait '${name}' mode=file needs 'path'`);
        if (mode === "shell" && !state.waitCommand) errors.push(`Wait '${name}' mode=shell needs 'command'`);
        if (mode === "webhook") {
          if (!state.waitPort) errors.push(`Wait '${name}' mode=webhook needs 'port'`);
          if (!state.waitPath) errors.push(`Wait '${name}' mode=webhook needs 'path'`);
        }
      }
      for (const d of [state.waitDuration, state.waitTimeout, state.waitPollInterval]) {
        if (d && !/^\d+\s*(ms|s|m|h)$/.test(d)) errors.push(`Wait '${name}' invalid duration '${d}' (expected e.g. "30s", "5m", "1h")`);
      }
      if (!state.on?.["DONE"]) errors.push(`Wait '${name}' must declare <on event="DONE" .../>`);
    }

    if (state.type === "call") {
      if (!state.callSkeleton) errors.push(`Call state '${name}' missing 'skeleton' attribute`);
      if (state.callArgsExpr) {
        try { compileGuardExpr(state.callArgsExpr); }
        catch (e: any) { errors.push(`Call state '${name}' args expr invalid: ${e.message}`); }
      }
      if (!state.on || !state.on["success"] || !state.on["error"]) {
        errors.push(`Call state '${name}' must declare both <on event="success" .../> and <on event="error" .../>`);
      }
      // Note: existence of target skeleton is checked at codegen time, not here.
    }

    if (state.type === "parallel") {
      if (!state.overExpr) errors.push(`Parallel state '${name}' missing 'over' attribute`);
      else {
        try { compileGuardExpr(state.overExpr); }
        catch (e: any) { errors.push(`Parallel state '${name}' over expr invalid: ${e.message}`); }
      }
      if (!state.parallelBranch) errors.push(`Parallel state '${name}' missing 'branch' attribute`);
      else if (!names.has(state.parallelBranch)) errors.push(`Parallel state '${name}' branch '${state.parallelBranch}' does not exist`);
      else {
        const bt = sk.states[state.parallelBranch].type;
        if (!BRANCH_ALLOWED.has(bt)) {
          errors.push(`Parallel state '${name}' branch '${state.parallelBranch}' must be one of [${[...BRANCH_ALLOWED].join(", ")}], got ${bt}`);
        }
      }
      if (!state.parallelJoin) errors.push(`Parallel state '${name}' missing 'join' attribute`);
      else if (!names.has(state.parallelJoin)) errors.push(`Parallel state '${name}' join '${state.parallelJoin}' does not exist`);
      if (state.concurrency !== undefined && (!Number.isInteger(state.concurrency) || state.concurrency < 1)) {
        errors.push(`Parallel state '${name}' concurrency must be a positive integer`);
      }
      continue;
    }

    if (state.type === "interactive" && (!state.artifacts || state.artifacts.length === 0)) {
      errors.push(`Interactive state '${name}' must declare at least one <artifacts><edit path=.../></artifacts>`);
    }

    if (state.type === "approval") {
      if (!state.prompt) errors.push(`Approval state '${name}' missing <prompt>`);
      if (state.autoEvent && state.on && !state.on[state.autoEvent]) {
        errors.push(`Approval state '${name}' auto-event '${state.autoEvent}' not in transitions`);
      }
    }

    if (!state.on || Object.keys(state.on).length === 0) {
      errors.push(`Non-final state '${name}' has no transitions`);
      continue;
    }

    for (const [event, target] of Object.entries(state.on)) {
      const targets = typeof target === "string" ? [{ target, guard: undefined }] : target;
      for (const gt of targets) {
        if (!names.has(gt.target)) errors.push(`State '${name}' event '${event}' → '${gt.target}' does not exist`);
        validateGuard(name, gt.guard, errors);
      }
    }
  }

  if (!hasFinal) errors.push("No final state defined");
  return errors;
}

function validateGuard(stateName: string, guard: string | undefined, errors: string[]): void {
  if (!guard) return;
  if (/^retries:\w+<\d+$/.test(guard)) return;
  if (guard.startsWith("expr:")) {
    try { compileGuardExpr(guard.slice(5)); }
    catch (e: any) { errors.push(`State '${stateName}' guard expr invalid: ${e.message}`); }
    return;
  }
  errors.push(`State '${stateName}' guard '${guard}' invalid (expected 'retries:key<N' or 'expr:...')`);
}
