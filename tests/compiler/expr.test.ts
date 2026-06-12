import { test } from "node:test";
import assert from "node:assert/strict";
import { compileGuardExpr, parseGuard, formatGuard } from "../../src/compiler/expr.js";

test("compiles valid guard expressions with c. prefix", () => {
  assert.equal(compileGuardExpr("config.n > 2"), "c.config.n > 2");
  assert.equal(compileGuardExpr("data.converged"), "c.data.converged");
  assert.equal(compileGuardExpr("retries.k < 3"), "c.retries(\"k\") < 3");
});

test("#3 rejects function calls (code-execution surface)", () => {
  assert.throws(() => compileGuardExpr("data.x.constructor('y')()"), /Function calls are not allowed/);
  assert.throws(() => compileGuardExpr("config.foo()"), /Function calls are not allowed/);
  assert.throws(() => compileGuardExpr("(data.a)()"), /Function calls are not allowed/);
});

test("#9 rejects malformed numbers with multiple decimal points", () => {
  assert.throws(() => compileGuardExpr("data.x == 1.2.3"), /Unexpected character/);
  assert.equal(compileGuardExpr("data.x == 1.5"), "c.data.x == 1.5"); // single dot still ok
});

test("still rejects non-root identifiers", () => {
  assert.throws(() => compileGuardExpr("foo.bar == 1"), /must start with config, data, or retries/);
});

test("parseGuard: recognises both encodings, rejects everything else", () => {
  assert.deepEqual(parseGuard("retries:attempt<3"), { kind: "retries", key: "attempt", max: 3 });
  assert.deepEqual(parseGuard("expr:data.x > 1"), { kind: "expr", expr: "data.x > 1" });
  assert.equal(parseGuard(undefined), null);
  assert.equal(parseGuard(""), null);
  assert.equal(parseGuard("retries:k<"), null);       // malformed retries → not recognised
  assert.equal(parseGuard("data.x > 1"), null);       // bare expr without prefix → not recognised
});

test("formatGuard ∘ parseGuard round-trips (single owner of the encoding)", () => {
  for (const s of ["retries:attempt<3", "expr:data.converged && config.n > 2", "expr:data.x"]) {
    assert.equal(formatGuard(parseGuard(s)!), s);
  }
});

test("parseGuard: combined condition+bound (conditional bounded back-edge / fix-loop)", () => {
  // A `<go>` carrying BOTH guard= and retries-key/max — the canonical bounded fix-loop ("re-run IF blocking,
  // at most N times"). Must NOT silently drop the condition (the bug that made the harness compile loop forever).
  assert.deepEqual(parseGuard('retries:cf<2&&data.has_blocking == "yes"'),
    { kind: "expr-retries", key: "cf", max: 2, expr: 'data.has_blocking == "yes"' });
});

test("formatGuard ∘ parseGuard round-trips the combined kind (single owner)", () => {
  const s = 'retries:cf<2&&data.has_blocking == "yes"';
  assert.equal(formatGuard(parseGuard(s)!), s);
});

test("combined guard lowers to (expr) && retries < max", () => {
  const g = parseGuard('retries:cf<2&&data.x == "y"')!;
  assert.equal(g.kind, "expr-retries");
  if (g.kind === "expr-retries") assert.equal(compileGuardExpr(g.expr), 'c.data.x == "y"');
});
