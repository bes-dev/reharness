import ts from "typescript";
import type { Skeleton, SkeletonState } from "../schema.js";
import { computeRoles, successors } from "./graph.js";
import { reachableFrom, solveMonotoneSets } from "./framework.js";
import { parseGuard } from "../expr.js";
import { RUNTIME_DATA_KEYS } from "../../runtime/types.js";

/** data.* keys the runtime always provides — never need an explicit writer (sourced from the runtime, not re-listed). */
const RUNTIME_KEYS = new Set(RUNTIME_DATA_KEYS.map(k => `data.${k}`));

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
    const g = parseGuard(guard);
    if (g?.kind === "expr") for (const c of configRefs(g.expr)) add(c, where);
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
  const g = parseGuard(guard);
  return g?.kind === "expr" ? dataRefs(g.expr) : [];
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
  if (state.type === "set") {
    // set assignments run SEQUENTIALLY (codegen emits c.data[k] = … line by line), so a value that reads a key
    // assigned EARLIER in this same set is satisfied locally — only its external reads are entry-requirements.
    const assignedHere = new Set<string>();
    for (const a of state.dataAssignments || []) {
      for (const k of dataRefs(a.value)) if (!assignedHere.has(k)) r.add(k);
      assignedHere.add(norm(a.key));
    }
  }
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

/** Is `node` the expression `<ctx>.data` (the property access `ctx.data`)? */
function isCtxData(node: ts.Expression, ctx: string): boolean {
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === ctx && node.name.text === "data";
}

/** The `<key>` a member access denotes (`.x` property or `["x"]` string-literal element), or undefined for a
 *  dynamic `[expr]` key we cannot name. */
function memberKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
}

/** Extract one code state's ctx.data reads/writes from its `<name>Entry` function body, over the AST. */
function entryDataIO(body: ts.Block, ctx: string): { reads: string[]; writes: string[] } {
  // Aliases of `<ctx>.data`: `const d = c.data` makes `d.x` mean `c.data.x`. (One hop; not transitive.)
  const aliases = new Set<string>();
  const collectAliases = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isCtxData(n.initializer, ctx))
      aliases.add(n.name.text);
    ts.forEachChild(n, collectAliases);
  };
  collectAliases(body);
  const isDataBase = (e: ts.Expression): boolean =>
    isCtxData(e, ctx) || (ts.isIdentifier(e) && aliases.has(e.text));

  const accessed = new Set<string>(); // every data.<key> touched
  const assigned = new Set<string>(); // data.<key> on the LHS of a `=` (under-approx: dynamic keys excluded)
  const visit = (n: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isDataBase(n.expression)) {
      const key = memberKey(n);
      if (key) {
        accessed.add(`data.${key}`);
        if (ts.isBinaryExpression(n.parent) && n.parent.left === n &&
            n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) assigned.add(`data.${key}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { reads: [...accessed].filter(k => !assigned.has(k)), writes: [...assigned] };
}

/**
 * Deterministically extract each code state's ctx.data dependencies from the generated lib source, over the
 * TypeScript AST (`ts.createSourceFile`, parse only — no type-checker). For each top-level `<name>Entry`
 * function: writes = keys on the LHS of a `<ctx>.data.<key> =`; reads = every other `<ctx>.data.<key>` access.
 * Unlike text scanning, this sees the string-literal form (`c.data["x"]`), reads the context parameter name
 * from the signature (not assumed to be `c`), follows a one-hop `const d = c.data` alias, and is bounded by the
 * real function body (a sibling top-level helper is NOT mis-attributed). Soundness: writes are UNDER-approximated
 * and reads OVER-approximated (a dynamic `c.data[expr]` key we cannot name is left out of writes), so the
 * downstream forward-MUST analysis never silently MISSES a genuinely-undefined read. (Interprocedural reads via
 * a called helper remain out of scope; agents touch only the file workspace, never ctx.data, so they have none.)
 */
export function extractCodeDataIO(libSource: string): Map<string, { reads: string[]; writes: string[] }> {
  const out = new Map<string, { reads: string[]; writes: string[] }>();
  const sf = ts.createSourceFile("lib.ts", libSource, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body) continue;
    const m = /^(.+)Entry$/.exec(stmt.name.text);
    if (!m) continue;
    const p0 = stmt.parameters[0]?.name;
    const ctx = p0 && ts.isIdentifier(p0) ? p0.text : "c";
    out.set(m[1], entryDataIO(stmt.body, ctx));
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
