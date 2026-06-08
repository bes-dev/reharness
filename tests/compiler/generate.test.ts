import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { buildGeneratePipeline } from "../../src/compiler/generate.js";

const P = () => buildGeneratePipeline({ cwd: "/tmp/x", input: "y" });

test("generate ends at a verified base — verify PASS routes to done (enhance is a separate pipeline)", () => {
  const p = P();
  const verify = p.states.verify as any;
  assert.equal(verify.on.PASS, "done");
  // enhance is no longer a node in /generate — it's its own self-hosted pipeline (enhance.ts).
  assert.ok(!("enhance" in p.states), "enhance must not be a state in the generate graph");
});

test("verify failure surfaces the reason in ctx.data.error (so the error terminal fails loud, not 'no reason set')", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-vf-"));
  try {
    mkdirSync(resolve(dir, "reharness/.cache/scratch"), { recursive: true });   // build the pipeline; no commands/ → verify fails
    const p = buildGeneratePipeline({ cwd: dir, input: "" });
    const c: any = { config: {}, data: {}, emit: () => {}, retries: () => 0, retry: () => {}, dir: () => "", dirs: () => [] };
    assert.equal(await (p.states as any).verify.entry(c), "FAIL");
    assert.equal(typeof c.data.error, "string");
    assert.match(c.data.error, /verify: \d+ error\(s\)/);                   // the loud-fail boundary now has a reason
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("improve (amend) front: start switch → load_amend → amend_prd → review_prd → amend_design → shared tail", () => {
  const p = P();
  const s = p.states as any;
  // all three fronts are statically reachable from the start switch (session vs amend vs compile)
  assert.deepEqual(s.start.branches.map((b: any) => b.target), ["load_session", "load_amend", "maybe_research"]);
  assert.equal(s.load_amend.on.DONE, "amend_prd");
  assert.equal(s.amend_prd.on.DONE, "maybe_approve_prd"); // PRD agents now route DONE/ERROR (recoverPrd safety net)
  // on approval, amend mode delta-edits the seeded skeleton; generate designs from scratch — both rejoin at construct
  assert.deepEqual(s.review_prd.on.APPROVED.map((t: any) => t.target), ["amend_design", "design"]);
  assert.equal(s.amend_design.on, "construct");
  assert.equal(s.design.on, "construct");
});
