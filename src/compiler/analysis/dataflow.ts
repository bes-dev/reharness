import type { Skeleton, SkeletonState } from "../schema.js";
import { computeRoles, successors } from "./graph.js";
import { reachableFrom, solveMonotoneSets } from "./framework.js";

/** data.* keys the runtime always provides — never need an explicit writer. */
const RUNTIME_KEYS = new Set([
  "data.branches", "data.iteration", "data.iterations", "data.webhookBody", "data.webhookHeaders",
]);

/** Normalise a key to its namespace form. Bare names (e.g. set keys) become data.<name>. */
function norm(k: string): string {
  return /^(data|config|retries)\./.test(k) ? k : `data.${k}`;
}

/** Extract every `data.<id>` reference from an expression string. */
function dataRefs(expr: string | undefined): string[] {
  if (!expr) return [];
  return [...expr.matchAll(/\bdata\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => `data.${m[1]}`);
}

/** Extract every `config.<id>` reference from an expression string. */
function configRefs(expr: string | undefined): string[] {
  if (!expr) return [];
  return [...expr.matchAll(/\bconfig\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
}

/**
 * config-flow check: every `config.<name>` the pipeline READS must be declared in `<inputs>` (or be one of the
 * always-provided fields `target`/`input`). The CLI interface is external — it can't be derived from the graph
 * (no producer node, no edge) — so it is declared, codegen generates the parser from it, and THIS check verifies
 * the pipeline never reads an undeclared config field → the CLI wiring is correct by construction. Scans skeleton
 * expressions (guards/over/exit/model-expr/set) always; extends to code-state source when `libSource` is given.
 */
export function configFlowErrors(sk: Skeleton, libSource?: string): string[] {
  const declared = new Set<string>(["target", "input"]);
  for (const i of sk.inputs || []) declared.add(i.name);

  const used = new Map<string, string>(); // field → first site (for the message)
  const add = (field: string, where: string) => { if (!used.has(field)) used.set(field, where); };
  const exprConfig = (guard: string | undefined, where: string) => {
    if (guard?.startsWith("expr:")) for (const c of configRefs(guard.slice(5))) add(c, where);
  };

  for (const [name, st] of Object.entries(sk.states)) {
    for (const c of configRefs(st.modelExpr)) add(c, `state '${name}' model-expr`);
    for (const c of configRefs(st.overExpr)) add(c, `state '${name}' over`);
    for (const c of configRefs(st.exitExpr)) add(c, `state '${name}' exit`);
    for (const gt of st.branches || []) exprConfig(gt.guard, `state '${name}' guard`);
    for (const t of Object.values(st.on || {})) if (typeof t !== "string") for (const gt of t) exprConfig(gt.guard, `state '${name}' guard`);
    for (const a of st.dataAssignments || []) for (const c of configRefs(a.value)) add(c, `state '${name}' set`);
  }
  if (libSource) for (const m of libSource.matchAll(/\bc\.config\.([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], "code");

  const errors: string[] = [];
  for (const [field, where] of used) {
    if (!declared.has(field)) {
      errors.push(`config.${field} is read (${where}) but not declared in <inputs> — add <arg name="${field}" .../> so the command parses it from the CLI.`);
    }
  }
  return errors;
}

function guardRefs(guard?: string): string[] {
  return guard?.startsWith("expr:") ? dataRefs(guard.slice(5)) : [];
}

/** ctx.data keys a node DEFINITELY sets. Only code/set states write ctx.data (agents move data through the
 *  per-stage workspace, which the topology wires deterministically — out of scope for this analysis). */
function writesOf(state: SkeletonState): Set<string> {
  const w = new Set<string>();
  if (state.type === "agent" || state.type === "interactive") return w;
  for (const k of state.writes || []) { const n = norm(k); if (n.startsWith("data.")) w.add(n); }
  if (state.type === "set") for (const a of state.dataAssignments || []) w.add(norm(a.key));
  return w;
}

/** ctx.data keys a node REQUIRES on ENTRY (checked against IN[n], the keys written on every path BEFORE n):
 *  declared reads + `over` (parallel, evaluated at entry) + set-value expressions (evaluated as the set runs). */
function entryReadsOf(state: SkeletonState): Set<string> {
  const r = new Set<string>();
  for (const k of state.reads || []) { const n = norm(k); if (n.startsWith("data.")) r.add(n); }
  for (const k of dataRefs(state.overExpr)) r.add(k);
  if (state.type === "set") for (const a of state.dataAssignments || []) for (const k of dataRefs(a.value)) r.add(k);
  return r;
}

/** ctx.data keys read AFTER the node's body runs (checked against IN[n] ∪ writesOf(n)): guards on the node's
 *  OWN outgoing transitions. Guards are evaluated after entry, so a value the node itself writes is available —
 *  checking them against IN[n] alone would falsely flag `code state writes data.x; <go guard="expr:data.x">`.
 *  (`exit` on a loop is likewise post-body; it routes via the loop, not this node, so it isn't read here.) */
function afterReadsOf(state: SkeletonState): Set<string> {
  const r = new Set<string>();
  for (const gt of state.branches || []) for (const k of guardRefs(gt.guard)) r.add(k);
  for (const t of Object.values(state.on || {})) {
    if (typeof t !== "string") for (const gt of t) for (const k of guardRefs(gt.guard)) r.add(k);
  }
  return r;
}

/**
 * Deterministically extract each code state's ctx.data dependencies from the generated lib source.
 * Writes = `c.data.X =` assignments. Reads-required = `c.data.X` referenced but NOT assigned in the same
 * function (a producer of X doesn't require X on entry). This is the `annotate` layer: it formalises the
 * part of the contract that is structured by nature (real code), so code states need no hand-declared
 * reads/writes — only agent/interactive states (whose file I/O isn't visible in code) declare theirs.
 */
export function extractCodeDataIO(libSource: string): Map<string, { reads: string[]; writes: string[] }> {
  const out = new Map<string, { reads: string[]; writes: string[] }>();
  const fnRe = /export function (\w+)Entry\s*\([^)]*\)[^{]*\{/g;
  const fns = [...libSource.matchAll(fnRe)];
  for (let i = 0; i < fns.length; i++) {
    const name = fns[i][1];
    const body = libSource.slice(fns[i].index! + fns[i][0].length, i + 1 < fns.length ? fns[i + 1].index! : libSource.length);
    const writes = new Set([...body.matchAll(/c\.data\.(\w+)\s*=(?!=)/g)].map(m => `data.${m[1]}`));
    const reads = new Set<string>();
    for (const m of body.matchAll(/c\.data\.(\w+)/g)) { const k = `data.${m[1]}`; if (!writes.has(k)) reads.add(k); }
    out.set(name, { reads: [...reads], writes: [...writes] });
  }
  return out;
}

/** Merge extracted code-state I/O into the skeleton's declared reads/writes (code wins for code states). */
export function applyCodeDataIO(sk: Skeleton, io: Map<string, { reads: string[]; writes: string[] }>): void {
  for (const [name, st] of Object.entries(sk.states)) {
    if (st.type !== "code") continue;
    const e = io.get(name);
    if (!e) continue;
    st.reads = e.reads;
    st.writes = e.writes;
  }
}

/**
 * Definite-assignment (use-before-def) analysis over data.* keys — a textbook **forward MUST data-flow**
 * (an instance of solveMonotoneSets with `meet="intersect"`, `gen = writesOf`): IN[n] holds the keys
 * written on EVERY path reaching n. A `data.*` key a node reads must be in IN[n] — otherwise some path
 * leaves it undefined at runtime. Sound: only flags a read when a writer-free path provably exists.
 */
export function analyzeDataFlow(sk: Skeleton): string[] {
  const errors: string[] = [];
  if (!sk.initial || !sk.states[sk.initial]) return errors; // structural problem — reported by validateSkeleton

  const roles = computeRoles(sk);
  const reach = reachableFrom([sk.initial], n => successors(sk, n, roles).filter(x => sk.states[x]));

  // Predecessor map over the reachable set.
  const preds = new Map<string, string[]>([...reach].map(n => [n, [] as string[]]));
  for (const n of reach) for (const nx of successors(sk, n, roles)) if (reach.has(nx)) preds.get(nx)!.push(n);

  const IN = solveMonotoneSets({
    nodes: reach,
    preds: n => preds.get(n) ?? [],
    entry: sk.initial,
    gen: n => writesOf(sk.states[n]),
    meet: "intersect",
  });

  const flag = (n: string, k: string) => errors.push(
    `State '${n}' reads ${k}, but ${k} is not written on every path reaching '${n}' — it can be undefined at runtime. ` +
    `Ensure a predecessor on every path sets it (declare ${k} in that node's writes=, or insert a node that initialises it).`,
  );
  for (const n of reach) {
    const inn = IN.get(n)!;
    for (const k of entryReadsOf(sk.states[n])) {
      if (!RUNTIME_KEYS.has(k) && !inn.has(k)) flag(n, k);
    }
    // After-reads (own guards) see IN[n] ∪ the node's own writes (its body has already run).
    const afterAvail = new Set([...inn, ...writesOf(sk.states[n])]);
    for (const k of afterReadsOf(sk.states[n])) {
      if (!RUNTIME_KEYS.has(k) && !afterAvail.has(k)) flag(n, k);
    }
  }
  return errors;
}
