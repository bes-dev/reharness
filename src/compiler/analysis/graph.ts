import type { Skeleton, GuardedTransition } from "../schema.js";
import { reachableFrom } from "./framework.js";

/**
 * Shared FSM-graph traversal. The single source of truth for "what does a state lead to", used by
 * structural validation (reachability/dead-ends), the data-flow analyzer, and codegen role dispatch.
 */

export interface RoleMaps {
  /** parallel branch state → the parallel's join target */
  branchJoin: Map<string, string>;
  /** loop step state → the loop's join target */
  stepJoin: Map<string, string>;
  /** every parallel branch / loop step, even if the parent's join is missing */
  bodyStates: Set<string>;
}

/** Map each parallel branch / loop step to the join its parent advances to after it runs. */
export function computeRoles(sk: Skeleton): RoleMaps {
  const branchJoin = new Map<string, string>();
  const stepJoin = new Map<string, string>();
  const bodyStates = new Set<string>();
  for (const s of Object.values(sk.states)) {
    if (s.type === "parallel" && s.parallelBranch) {
      bodyStates.add(s.parallelBranch);
      if (s.join) branchJoin.set(s.parallelBranch, s.join);
    }
    if (s.type === "loop") for (const step of s.loopSteps || []) {
      bodyStates.add(step);
      if (s.join) stepJoin.set(step, s.join);
    }
  }
  return { branchJoin, stepJoin, bodyStates };
}

/**
 * Successor state names, role-aware: a parallel branch / loop step returns to its parent's join rather
 * than routing via its own (runtime-ignored) `<on>`; a code state with no explicit ERROR implicitly
 * routes to `error` (mirrors codegen's emitState). Covers every edge kind: on-transitions, switch
 * branches, parallel branch+join, loop steps+join.
 */
export function successors(sk: Skeleton, name: string, roles: RoleMaps): string[] {
  const st = sk.states[name];
  if (!st) return [];
  const out: string[] = [];

  // A composite state always RUNS its body (parallel branch / loop steps) — these stay reachable even
  // when the state is itself a loop step or parallel branch (nested composition). Must be added before
  // the body-state short-circuit below, or a nested parallel/loop's body looks unreachable.
  if (st.type === "parallel" && st.parallelBranch) out.push(st.parallelBranch);
  if (st.type === "loop") for (const s of st.loopSteps || []) out.push(s);

  // Where control goes AFTER this state completes: a body state (branch/step) returns to its parent's
  // join — its own <on> is runtime-ignored. Otherwise it follows its own routing.
  if (roles.branchJoin.has(name)) { out.push(roles.branchJoin.get(name)!); return out; }
  if (roles.stepJoin.has(name)) { out.push(roles.stepJoin.get(name)!); return out; }

  const pushOn = (on?: Record<string, string | GuardedTransition[]>) => {
    for (const t of Object.values(on || {})) {
      if (typeof t === "string") out.push(t);
      else for (const g of t) out.push(g.target);
    }
  };
  if (st.type === "switch") { for (const g of st.branches || []) out.push(g.target); return out; }
  if (st.type === "parallel" || st.type === "loop") { if (st.join) out.push(st.join); pushOn(st.on); return out; }
  pushOn(st.on);
  if (st.type === "code" && !st.on?.["ERROR"]) out.push("error");
  return out;
}

/** Producer state types — the ones that write a workspace output dir (agents/code/interactive). Structural
 *  states (switch/set/parallel/loop/wait/call/final) produce no files and are "transparent" to data flow. */
const PRODUCER = new Set<Skeleton["states"][string]["type"]>(["agent", "code", "interactive"]);

/**
 * Per-state ENCLOSING-COMPOSITE chain (the FSM analogue of a polyhedral iteration space's surrounding loops):
 * the ordered list of `parallel`/`loop` states that contain a state, outermost-first. A state's runtime
 * INSTANCE is addressed by one index per element of this chain (a parallel's branch index / a loop's iteration)
 * — its iteration vector. Length-0 chain = a single top-level instance.
 */
export function enclosingScope(sk: Skeleton): Map<string, string[]> {
  const parent = new Map<string, string>(); // body state → its immediately-enclosing composite
  for (const [n, s] of Object.entries(sk.states)) {
    if (s.type === "parallel" && s.parallelBranch) parent.set(s.parallelBranch, n);
    if (s.type === "loop") for (const step of s.loopSteps || []) parent.set(step, n);
  }
  const scope = new Map<string, string[]>();
  for (const n of Object.keys(sk.states)) {
    const chain: string[] = [];
    for (let cur = n; parent.has(cur); ) { const p = parent.get(cur)!; chain.unshift(p); cur = p; }
    scope.set(n, chain);
  }
  return scope;
}

const commonPrefixLen = (a: string[], b: string[]): number => {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i;
};

/**
 * The producer stages whose output is VISIBLE to `name`, classified by output CARDINALITY — the instance-wise
 * dataflow rule (polyhedral / Feautrier). Visibility is a **MAY-reachability** query (any graph-ancestor
 * producer, backward reachability through structural nodes). Cardinality is decided by the shared iteration
 * space of producer P and consumer N (`enclosingScope`):
 *   - `single` — every enclosing composite of P also encloses N (P's instance is fixed by N's outer context):
 *                one dir. Covers linear, and same-scope reads (incl. loop-carried: the runtime resolves the
 *                latest-existing instance ≤ N's current iteration).
 *   - `list`   — N has EXITED ≥1 enclosing composite of P → P appears as a COLLECTION over those axes: one dir
 *                per branch (exited parallel = map) and/or per iteration (exited loop = scan / history).
 * One law for parallel and loop, and for any nesting depth.
 */
export function visibleProducers(sk: Skeleton, name: string, roles: RoleMaps): { single: string[]; list: string[] } {
  // Reverse edges, then ancestors = backward may-reachability from `name` (excluding `name` itself).
  const rev = new Map<string, string[]>();
  for (const n of Object.keys(sk.states)) for (const s of successors(sk, n, roles)) {
    (rev.get(s) ?? rev.set(s, []).get(s)!).push(n);
  }
  const anc = reachableFrom(rev.get(name) ?? [], n => rev.get(n) ?? []);
  anc.delete(name);

  const scope = enclosingScope(sk);
  const scopeN = scope.get(name) ?? [];

  // Loop-carried visibility: steps of a loop co-execute across iterations, so a step may read any co-step
  // (an earlier one this iteration, a later one from the previous iteration). The graph routes each step to
  // the join, not to its siblings, so add every producer that shares an enclosing LOOP with `name`.
  const loopsOfN = scopeN.filter(c => sk.states[c]?.type === "loop");
  if (loopsOfN.length) for (const a of Object.keys(sk.states)) {
    if (a !== name && PRODUCER.has(sk.states[a].type) && loopsOfN.some(L => (scope.get(a) ?? []).includes(L))) anc.add(a);
  }

  const single: string[] = [], list: string[] = [];
  for (const a of Object.keys(sk.states)) {
    if (!anc.has(a) || !PRODUCER.has(sk.states[a].type)) continue;
    const scopeP = scope.get(a) ?? [];
    // P is a collection iff some enclosing composite of P is one N has exited (scopeP longer than the shared prefix).
    (scopeP.length > commonPrefixLen(scopeP, scopeN) ? list : single).push(a);
  }
  return { single, list };
}

/** State → its structural role, for codegen template dispatch (branch/join/step). */
export function stateRoleMap(sk: Skeleton): Map<string, "branch" | "join" | "step"> {
  const { branchJoin, stepJoin } = computeRoles(sk);
  const m = new Map<string, "branch" | "join" | "step">();
  for (const [branch, join] of branchJoin) { m.set(branch, "branch"); m.set(join, "join"); }
  for (const [step, join] of stepJoin) { m.set(step, "step"); m.set(join, "join"); }
  return m;
}
