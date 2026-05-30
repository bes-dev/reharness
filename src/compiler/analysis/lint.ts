import type { Skeleton, SkeletonState } from "../schema.js";
import { RESERVED_IDS } from "../schema.js";
import { compileGuardExpr } from "../expr.js";
import { computeRoles } from "./graph.js";

/** State types allowed as a `parallel` branch / loop step. Nested parallel/loop is fine: every stage instance
 * is addressed by its full iteration vector (`work/<stage>/<i0>/<i1>/…`), so nested concurrent fan-outs don't
 * collide. Excludes routing-only (switch/check), terminal (final), and interactive (terminal stdio contention).
 * A loop step also allows `approval` (sequential — no contention); a parallel branch does not. */
const BRANCH_ALLOWED = new Set<SkeletonState["type"]>(["agent", "code", "set", "parallel", "loop"]);
const STEP_ALLOWED = new Set<SkeletonState["type"]>(["agent", "code", "set", "approval", "parallel", "loop"]);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Lint pass: grammar / well-formedness of a skeleton document. Required fields per type, valid identifiers,
 * reference validity (every transition/branch/join/step target exists), allowed event sets, and expression
 * compilation (guard/over/exit/set-value/model-expr). These are the format's "type system" — they almost
 * always pass silently; a failure means the document itself is malformed. Behaviour of the resulting FSM
 * (reachability, dead-ends, data-flow, runtime mechanism rules) is the SEMANTIC pass's job — see semantic.ts.
 */
export function lintSkeleton(sk: Skeleton): string[] {
  const errors: string[] = [];
  const names = new Set(Object.keys(sk.states));

  if (!sk.id) errors.push("Missing 'id'");
  if (!sk.description) errors.push("Missing 'description'");
  if (!sk.usage) errors.push("Missing 'usage'");
  if (!sk.initial) errors.push("Missing 'initial'");
  if (sk.initial && !names.has(sk.initial)) errors.push(`Initial state '${sk.initial}' does not exist`);

  // Identifiers: state names become TS function/object identifiers; event names become object keys.
  // Codegen emits them verbatim, so a hyphen here produces invalid TypeScript (caught here, not at verify).
  if (sk.id && !/^[a-z][a-z0-9-]*$/.test(sk.id)) {
    errors.push(`Skeleton id '${sk.id}' must be lowercase kebab-case (letters, digits, hyphens).`);
  }
  if (sk.id && RESERVED_IDS.has(sk.id)) {
    errors.push(`Skeleton id '${sk.id}' is reserved — 'generate' and 'evolve' are used by reharness itself.`);
  }
  for (const [name, state] of Object.entries(sk.states)) {
    if (!IDENT.test(name)) {
      errors.push(`State name '${name}' is not a valid identifier — state names become TypeScript identifiers. Use snake_case or camelCase, no hyphens.`);
    }
    for (const event of Object.keys(state.on || {})) {
      if (!IDENT.test(event)) {
        errors.push(`State '${name}' event '${event}' is not a valid identifier (becomes an object key in generated code).`);
      }
    }
  }

  const TIMEOUT_FORBIDDEN = new Set<SkeletonState["type"]>(["switch", "set", "final", "wait"]);

  // Role maps come from the shared graph module (see graph.ts). A parallel branch / loop step routes via
  // its parent's join, not its own <on>, and is exempt from the "must have transitions" rule.
  const roles = computeRoles(sk);
  const isBranchOrStep = (n: string) => roles.bodyStates.has(n);

  let hasFinal = false;
  for (const [name, state] of Object.entries(sk.states)) {
    if (state.timeout) {
      if (!/^\d+\s*(ms|s|m|h)$/.test(state.timeout)) {
        errors.push(`State '${name}' timeout '${state.timeout}' invalid (expected e.g. "30s", "5m")`);
      }
      if (TIMEOUT_FORBIDDEN.has(state.type)) {
        errors.push(`State '${name}' type=${state.type} cannot have timeout`);
      }
    }
    if (state.modelExpr) {
      if (state.type !== "agent") {
        errors.push(`State '${name}' type=${state.type} cannot have model-expr (only agent states)`);
      } else {
        try { compileGuardExpr(state.modelExpr); }
        catch (e: any) { errors.push(`State '${name}' model-expr invalid: ${e.message}`); }
      }
    }

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
          else if (!IDENT.test(a.key)) errors.push(`Set state '${name}' data key '${a.key}' is not a valid identifier (it is referenced as data.${a.key} in expressions).`);
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
      if (!state.join) errors.push(`Loop state '${name}' has no next state — add <on event="DONE" target="..."/> naming where to go after the loop finishes.`);
      else if (!names.has(state.join)) errors.push(`Loop state '${name}' <on event="DONE"> target '${state.join}' does not exist`);
      for (const ev of Object.keys(state.on || {})) {
        if (ev !== "TIMEOUT") errors.push(`Loop state '${name}' <on event="${ev}"> is not allowed — a loop uses only <on event="DONE"> (next state after the loop) and optional <on event="TIMEOUT">. The <step>s are the body.`);
      }
      // Termination guarantee: a loop is bounded iteration, so it MUST carry a hard bound `max` (the loop
      // variant). `exit` is an optional early-out — but on its own it can diverge if the predicate never
      // holds (a real risk with LLM-generated guards), so it never substitutes for the bound.
      if (state.maxIterations === undefined) {
        errors.push(`Loop state '${name}' must declare 'max' (a hard iteration bound — guarantees termination). 'exit' is an optional early-out, not a substitute.`);
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
      if (!state.join) errors.push(`Parallel state '${name}' has no next state — add <on event="DONE" target="..."/> naming where to go after all branches settle.`);
      else if (!names.has(state.join)) errors.push(`Parallel state '${name}' <on event="DONE"> target '${state.join}' does not exist`);
      if (state.concurrency !== undefined && (!Number.isInteger(state.concurrency) || state.concurrency < 1)) {
        errors.push(`Parallel state '${name}' concurrency must be a positive integer`);
      }
      for (const ev of Object.keys(state.on || {})) {
        if (ev !== "TIMEOUT") errors.push(`Parallel state '${name}' <on event="${ev}"> is not allowed — a parallel uses only <on event="DONE"> (next state after fan-out) and optional <on event="TIMEOUT">. The branch= runs per item.`);
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
      // Branch/step states route structurally (parallel join / loop join), not via <on> — exempt them.
      if (!isBranchOrStep(name)) errors.push(`Non-final state '${name}' has no transitions`);
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

  // Codegen synthesizes an `ERROR → 'error'` transition for any code state lacking an explicit ERROR handler
  // (the generated entry's catch returns 'ERROR'). That target must exist, or the generated command references
  // a nonexistent state — caught only at runtime-load otherwise. Require an `error` state by construction.
  const codeNeedsError = Object.values(sk.states).some(s => s.type === "code" && !s.on?.["ERROR"]);
  if (codeNeedsError && !names.has("error")) {
    errors.push(`A code state can fail (its generated handler routes ERROR → 'error'), but no state named 'error' exists. Add <state name="error" type="final" status="error"/> (or give every code state an explicit <on event="ERROR" .../>).`);
  }

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
