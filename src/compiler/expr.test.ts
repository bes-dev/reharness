import { test } from "node:test";
import assert from "node:assert/strict";
import { compileGuardExpr } from "./expr.js";

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
