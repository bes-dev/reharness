import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDataFlow, extractCodeDataIO } from "../../../src/compiler/analysis/dataflow.js";
import type { Skeleton } from "../../../src/compiler/schema.js";

/** Helper: extract one entry's I/O, with reads/writes sorted for stable comparison. */
function io(src: string, state: string): { reads: string[]; writes: string[] } {
  const e = extractCodeDataIO(src).get(state)!;
  return { reads: [...e.reads].sort(), writes: [...e.writes].sort() };
}

/** #4: a code state that WRITES data.x and then has an outgoing guard reading data.x must NOT be flagged —
 *  guards are evaluated after the node's body, so the value is available. */
test("#4 no false use-before-def when a node's own guard reads what the node writes", () => {
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "n",
    states: {
      n: { type: "code", writes: ["data.x"], on: { DONE: [{ target: "done", guard: "expr:data.x" }, { target: "done" }] } },
      done: { type: "final", status: "success" },
    },
  };
  assert.deepEqual(analyzeDataFlow(sk), []);
});

/** Soundness preserved: a guard reading a key NOBODY writes is still flagged. */
test("#4 still flags a genuinely-undefined data read in a guard", () => {
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "n",
    states: {
      n: { type: "code", writes: [], on: { DONE: [{ target: "done", guard: "expr:data.y" }, { target: "done" }] } },
      done: { type: "final", status: "success" },
    },
  };
  const errs = analyzeDataFlow(sk);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /data\.y/);
});

// ── extractCodeDataIO over the AST: cases the old regex extractor got wrong ──

test("extractCodeDataIO: basic property reads/writes", () => {
  const src = `export async function fooEntry(c: any): Promise<'DONE'> {
    const x = c.data.input; c.data.out = x + 1; return 'DONE';
  }`;
  assert.deepEqual(io(src, "foo"), { reads: ["data.input"], writes: ["data.out"] });
});

test("extractCodeDataIO: string-literal element access (regex missed bracket form)", () => {
  // c.data["userId"] is a READ the old `c\.data\.(\w+)` regex never saw → unsound use-before-def miss.
  const src = `export async function authEntry(c: any): Promise<'DONE'> {
    const u = c.data["userId"]; c.data["token"] = sign(u); return 'DONE';
  }`;
  assert.deepEqual(io(src, "auth"), { reads: ["data.userId"], writes: ["data.token"] });
});

test("extractCodeDataIO: one-hop `const d = c.data` alias", () => {
  const src = `export async function aliasEntry(c: any): Promise<'DONE'> {
    const d = c.data; const n = d.count; d.total = n * 2; return 'DONE';
  }`;
  assert.deepEqual(io(src, "alias"), { reads: ["data.count"], writes: ["data.total"] });
});

test("extractCodeDataIO: context param need not be named `c`", () => {
  const src = `export async function ctxEntry(ctx: any): Promise<'DONE'> {
    const p = ctx.data.path; ctx.data.size = stat(p); return 'DONE';
  }`;
  assert.deepEqual(io(src, "ctx"), { reads: ["data.path"], writes: ["data.size"] });
});

test("extractCodeDataIO: an UNCALLED sibling helper is not mis-attributed to a state", () => {
  // A helper defined nearby but NOT called must stay isolated (the AST-bounding fix; no text-offset leak).
  const src = `function helper(c: any) { return c.data.leaked; }
export async function realEntry(c: any): Promise<'DONE'> { c.data.out = 1; return 'DONE'; }`;
  const m = extractCodeDataIO(src);
  assert.equal(m.has("helper"), false, "non-Entry helper is not a state");
  assert.deepEqual(io(src, "real"), { reads: [], writes: ["data.out"] });
});

test("extractCodeDataIO: a CALLED ctx-threaded helper's data I/O is folded into the caller (interprocedural)", () => {
  // The real bug: a code state factors its data writes into a helper (`stash(c)`). Without following the call the
  // write looks unwritten → a phantom use-before-def. The helper's read is folded too (sound over-approximation).
  const src = `function stash(c: any) { c.data.stashed = 1; }
function reader(c: any) { return c.data.leaked; }
function untouched(c: any) { c.data.never = 1; }
export async function realEntry(c: any): Promise<'DONE'> { stash(c); c.data.out = reader(c); return 'DONE'; }`;
  assert.deepEqual(io(src, "real"), { reads: ["data.leaked"], writes: ["data.out", "data.stashed"] });
});

test("extractCodeDataIO: nested closure writes are seen; data read-and-written counts as write only", () => {
  const src = `export async function loopEntry(c: any): Promise<'DONE'> {
    c.data.acc = 0;
    [1,2].forEach(() => { c.data.acc = c.data.acc + 1; });
    return 'DONE';
  }`;
  // acc is both read and written → write-only in the IN/OUT model (matches the prior set semantics).
  assert.deepEqual(io(src, "loop"), { reads: [], writes: ["data.acc"] });
});
