import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { buildEnhancePipeline } from "../../src/compiler/enhance.js";

const P = () => buildEnhancePipeline("/tmp/x");

const SK = (id: string) =>
  `<skeleton id="${id}" initial="work" format-version="0.5"><description>${id}</description><usage>u</usage>` +
  `<state name="work" type="agent"><contract><![CDATA[do]]></contract><on event="DONE" target="done"/></state>` +
  `<state name="done" type="final" status="success"/></skeleton>`;
const ctx = (): any => ({ data: {}, emit: () => {} });

test("enhance is a fan-out: plan_leaves → parallel(harness_leaf) → verify_harness", () => {
  const p = P();
  assert.ok("plan_leaves" in p.states, "plan_leaves entry state present");
  const harness = p.states.harness as any;
  assert.equal(harness.type, "parallel");
  assert.equal(harness.branch, "harness_leaf");
  assert.equal(harness.join, "verify_harness");
});

test("verify_harness gates: PASS → done, FAIL → reconcile (never the global error terminal)", () => {
  const p = P();
  const vh = p.states.verify_harness as any;
  assert.equal(vh.on.PASS, "done");
  assert.equal(vh.on.FAIL, "reconcile");
  // graceful degradation: reconcile always rejoins done — a bad harness never fails the verified base.
  assert.equal((p.states.reconcile as any).on, "done");
});

test("no agent leaves short-circuits to done", () => {
  const planLeaves = P().states.plan_leaves as any;
  assert.equal(planLeaves.on.EMPTY, "done");
  assert.equal(planLeaves.on.DONE, "harness");
});

test("enhance scopes to the target command — does NOT re-plan a sibling's leaves (separate compilation)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-enh-"));
  try {
    const sk = resolve(dir, "reharness/skeletons");
    mkdirSync(sk, { recursive: true });
    writeFileSync(resolve(sk, "alpha.xml"), SK("alpha"));
    writeFileSync(resolve(sk, "beta.xml"), SK("beta"));

    // scoped to "alpha": only alpha's leaf is planned (beta, already enhanced, is left untouched)
    const c = ctx();
    assert.equal(await (buildEnhancePipeline(dir, "alpha").states as any).plan_leaves.entry(c), "DONE");
    assert.deepEqual(c.data.leaves, [{ name: "work", skeletonId: "alpha" }]);

    // unscoped (no command) ⇒ all commands' leaves — the fallback when the target can't be determined
    const c2 = ctx();
    await (buildEnhancePipeline(dir).states as any).plan_leaves.entry(c2);
    assert.deepEqual(c2.data.leaves.map((l: any) => l.skeletonId).sort(), ["alpha", "beta"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
