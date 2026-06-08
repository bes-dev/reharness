import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvolvePipeline } from "../../src/compiler/evolve.js";

const P = () => buildEvolvePipeline("/tmp/x");

test("read_verdict routes: success→extract(feedback)/stable, error→heal, nothing→noop", () => {
  const rv = P().states.read_verdict as any;
  assert.equal(rv.on.STABLE, "stable");
  assert.equal(rv.on.FEEDBACK, "refine_skills");
  assert.equal(rv.on.HEAL, "heal");
  assert.equal(rv.on.NONE, "noop");
});

test("feedback subgraph: refine_skills(parallel)→extract(parallel)→reconcile_tools→update_ledger→retention_trim→{improved|stable}", () => {
  const p = P();
  const rs = p.states.refine_skills as any;
  assert.equal(rs.type, "parallel");
  assert.equal(rs.branch, "refine_leaf");
  assert.equal(rs.join, "extract");
  const ex = p.states.extract as any;
  assert.equal(ex.type, "parallel");
  assert.equal(ex.branch, "extract_leaf");
  assert.equal(ex.join, "reconcile_tools");
  assert.equal((p.states.reconcile_tools as any).on, "update_ledger");
  assert.equal((p.states.update_ledger as any).on, "retention_trim");
  const rt = p.states.retention_trim as any;
  assert.equal(rt.on.IMPROVED, "improved");
  assert.equal(rt.on.STABLE, "stable");
});

test("heal → verify; verify gates: PASS→confirm_rerun, REPLAN→replan, FAIL→heal (bounded)", () => {
  const p = P();
  assert.equal((p.states.heal as any).on, "verify");
  const v = p.states.verify as any;
  assert.equal(v.on.PASS, "confirm_rerun");
  assert.equal(v.on.REPLAN, "replan");
  assert.ok(Array.isArray(v.on.FAIL), "FAIL is guarded (retry then error)");
  assert.equal(v.on.FAIL[0].target, "heal");
  assert.equal(v.on.FAIL[1].target, "error");
});

test("auto-redesign branch: replan→construct→fill_changed→verify_replan→{confirm_rerun|replan(bounded)}", () => {
  const p = P();
  assert.equal((p.states.replan as any).on, "construct");
  assert.equal((p.states.construct as any).on.DONE, "fill_changed");
  assert.equal((p.states.fill_changed as any).on, "verify_replan");
  const vr = p.states.verify_replan as any;
  assert.equal(vr.on.PASS, "confirm_rerun");
  assert.equal(vr.on.FAIL[0].target, "replan");
  assert.equal(vr.on.FAIL[1].target, "error");
  assert.ok(!("escalated" in p.states), "escalated terminal removed — topology is now repaired, not escalated");
});

test("confirm_rerun gates: DONE→fixed, RETRY→heal (bounded)", () => {
  const cr = P().states.confirm_rerun as any;
  assert.equal(cr.on.DONE, "fixed");
  assert.equal(cr.on.RETRY[0].target, "heal");
  assert.equal(cr.on.RETRY[1].target, "error");
});

test("terminals: stable/fixed/improved/noop are success, error is error", () => {
  const s = P().states as any;
  for (const t of ["stable", "fixed", "improved", "noop"]) assert.equal(s[t].status, "success", t);
  assert.equal(s.error.status, "error");
});
