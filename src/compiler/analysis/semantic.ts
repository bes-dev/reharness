import type { Skeleton } from "../schema.js";
import { computeRoles, successors } from "./graph.js";
import { reachableFrom } from "./framework.js";

/**
 * Semantic pass: behaviour of the FSM the skeleton denotes, not the well-formedness of the document
 * (that's lint.ts). Reachability: every state is reachable from initial, and every reachable state can
 * reach a final. Definite-assignment (use-before-def over ctx.data) is a separate semantic analysis kept
 * in dataflow.ts because it needs the generated lib source (run after fill). Inter-stage file flow needs
 * no check here — the compiler derives it from the topology (per-stage workspace), so it can't drift.
 */
export function analyzeSemantics(sk: Skeleton): string[] {
  const errors: string[] = [];
  const names = new Set(Object.keys(sk.states));
  const roles = computeRoles(sk);
  const isBranchOrStep = (n: string) => roles.bodyStates.has(n);

  // Graph-level, over role-aware successors (shared graph module). Both checks are plain REACHABILITY:
  //  - reachable    = forward closure from `initial`;
  //  - co-reachable = backward closure from the final states (over reverse edges) = "can reach a final".
  const succ = (n: string): string[] => successors(sk, n, roles).filter(x => names.has(x));
  if (sk.initial && names.has(sk.initial)) {
    const reach = reachableFrom([sk.initial], succ);
    for (const name of names) {
      if (!reach.has(name)) errors.push(`State '${name}' is unreachable from initial '${sk.initial}'.`);
    }

    const preds = new Map<string, string[]>([...names].map(n => [n, [] as string[]]));
    for (const n of names) for (const nx of succ(n)) preds.get(nx)!.push(n);
    const finals = [...names].filter(n => sk.states[n].type === "final");
    const coReach = reachableFrom(finals, n => preds.get(n) ?? []);
    for (const name of reach) {
      // Body states (parallel branch / loop step) terminate via their parent's join, which is checked
      // separately — skip them here to avoid cascade noise when the parent's <on event="DONE"> is missing.
      if (!isBranchOrStep(name) && !coReach.has(name)) {
        errors.push(`State '${name}' cannot reach any final state (dead-end or unbounded cycle with no exit).`);
      }
    }
  }

  return errors;
}

/** Coverage gate for the `contracts` pass: every reasoning/code node must declare a behavioural <contract>. */
export function validateContracts(sk: Skeleton): string[] {
  const errors: string[] = [];
  for (const [name, state] of Object.entries(sk.states)) {
    if ((state.type === "agent" || state.type === "code" || state.type === "interactive") && !state.contract?.trim()) {
      errors.push(`State '${name}' (${state.type}) is missing a <contract> — every reasoning/code node must declare what it guarantees.`);
    }
  }
  return errors;
}
