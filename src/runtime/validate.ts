import type { PipelineDefinition, ActiveState, TransitionTarget } from "./types.js";
import { isFinal, isApproval, isSwitch, isParallel, isLoop, isCall, isWait } from "./state-guards.js";

// Static validation of a pipeline definition: every transition target exists, every composite is well-formed,
// there is an initial and a final state. Runs once at definePipeline time; throws on the first batch of errors.

export function validate<C extends Record<string, any>>(def: PipelineDefinition<C>): void {
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
      if (!state.max) errors.push(`Loop "${name}" needs 'max' (guaranteed termination — 'exit' is an early-out, not a substitute)`);
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
