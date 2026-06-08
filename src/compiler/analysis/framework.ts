/**
 * Generic program-analysis primitives — the theory layer the FSM-specific analyses build on.
 *
 * Every static analysis in reharness is one of two textbook shapes over the state graph:
 *   1. REACHABILITY (transitive closure): "which nodes are reachable following a given edge relation?"
 *      — used for reachable-from-initial, can-reach-a-final (co-reachability over reverse edges), and the
 *      ancestor set behind data visibility. A plain worklist BFS; the lattice is trivial (a reachable set).
 *   2. MONOTONE DATA-FLOW (Kam–Ullman 1977): a fact lattice + a monotone transfer function per node +
 *      a meet operator, iterated to a fixpoint. Our only lattice is the powerset of string keys, so the
 *      engine is specialised to `Set<string>`. `meet = intersect` gives a MUST analysis (fact holds on
 *      EVERY path — e.g. definite assignment); `meet = union` gives a MAY analysis (fact holds on SOME path).
 *
 * Keeping both as named, reusable engines means each concrete check is a small problem instance, not a
 * bespoke fixpoint — and the may/must, forward/backward choices are explicit rather than improvised.
 */

/** Transitive closure: every node reachable from `starts` by following `next` (BFS). Includes `starts`. */
export function reachableFrom(starts: Iterable<string>, next: (n: string) => Iterable<string>): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...seen];
  while (queue.length) {
    for (const m of next(queue.shift()!)) if (!seen.has(m)) { seen.add(m); queue.push(m); }
  }
  return seen;
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every(x => b.has(x));

/**
 * Forward monotone data-flow over the powerset-of-keys lattice, gen-only transfer (`OUT = IN ∪ gen(n)`),
 * solved to a fixpoint. Returns IN[n] — the fact holding on entry to each node.
 *
 *   IN[n]  = meet over flow-predecessors p of OUT[p]      (entry node: IN = ∅, the boundary)
 *   OUT[n] = IN[n] ∪ gen(n)
 *
 * `meet="intersect"` → MUST analysis (∩; non-entry OUT seeded to the universe ⊤ so intersection narrows down)
 * `meet="union"`     → MAY analysis (∪; non-entry OUT seeded to ∅ ⊥).
 * Monotone + finite-height lattice ⇒ the iteration converges (Kam–Ullman).
 */
export function solveMonotoneSets(opts: {
  nodes: Iterable<string>;
  preds: (n: string) => string[];
  entry: string;
  gen: (n: string) => Set<string>;
  meet: "intersect" | "union";
}): Map<string, Set<string>> {
  const { preds, entry, gen, meet } = opts;
  const nodes = [...opts.nodes];

  const universe = new Set<string>();
  if (meet === "intersect") for (const n of nodes) for (const k of gen(n)) universe.add(k);
  const seed = (n: string): Set<string> =>
    n === entry ? gen(n) : (meet === "intersect" ? new Set(universe) : new Set());

  const OUT = new Map<string, Set<string>>(nodes.map(n => [n, seed(n)]));
  const IN = new Map<string, Set<string>>();

  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      if (n === entry) { IN.set(n, new Set()); continue; }
      const ps = preds(n);
      let inn = new Set<string>();
      if (ps.length) {
        inn = new Set(OUT.get(ps[0]));
        for (let i = 1; i < ps.length; i++) {
          const o = OUT.get(ps[i])!;
          inn = meet === "intersect" ? new Set([...inn].filter(x => o.has(x))) : new Set([...inn, ...o]);
        }
      }
      IN.set(n, inn);
      const out = new Set(inn);
      for (const k of gen(n)) out.add(k);
      if (!sameSet(out, OUT.get(n)!)) { OUT.set(n, out); changed = true; }
    }
  }
  return IN;
}
