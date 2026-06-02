import type { Skeleton } from "../schema.js";
import { lintSkeleton } from "./lint.js";
import { analyzeSemantics } from "./semantic.js";

/**
 * Static analysis of a skeleton, split by concern:
 *  - lint.ts      — grammar / well-formedness (the format's type system)
 *  - semantic.ts  — FSM behaviour: mechanism rules + reachability/dead-ends, plus contract coverage
 *  - dataflow.ts  — definite-assignment (use-before-def over ctx.data); needs the generated lib source
 *  - graph.ts     — shared role-aware traversal used by all of the above and by codegen
 */

/** Full structural validation = lint (grammar) + semantic (behaviour). The single entry point callers use
 *  for "is this skeleton valid?" (e.g. the in-session `validate` callback for structure/contracts/redesign). */
export function validateSkeleton(sk: Skeleton): string[] {
  return [...lintSkeleton(sk), ...analyzeSemantics(sk)];
}

export { lintSkeleton } from "./lint.js";
export { analyzeSemantics, validateContracts } from "./semantic.js";
export { analyzeDataFlow, configFlowErrors, extractCodeDataIO, applyCodeDataIO } from "./dataflow.js";
export { toolSafetyErrors } from "./tool-safety.js";
export { computeRoles, successors, visibleProducers, enclosingScope, stateRoleMap } from "./graph.js";
export type { RoleMaps } from "./graph.js";
