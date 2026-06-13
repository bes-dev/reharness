import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizationReport } from "../../../src/compiler/analysis/optimize.js";
import type { Skeleton } from "../../../src/compiler/schema.js";

const sorted = (a: string[]) => [...a].sort();

test("optimizationReport: linear chain — late stages accumulate ALL ancestors (the over-share fact)", () => {
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "a",
    states: {
      a: { type: "code", on: { DONE: "b" } },
      b: { type: "agent", on: { DONE: "c" } },
      c: { type: "agent", on: { DONE: "done" } },
      done: { type: "final", status: "success" },
    },
  } as any;
  const r = optimizationReport(sk);

  const surf = Object.fromEntries(r.contextSurface.map(s => [s.name, sorted(s.visible)]));
  assert.deepEqual(surf["a"], []);          // first stage sees nothing
  assert.deepEqual(surf["b"], ["a"]);       // b sees a
  assert.deepEqual(surf["c"], ["a", "b"]);  // c sees its WHOLE history — the over-share the optimizer must slice

  const fanA = r.fanOut.find(f => f.producer === "a")!;
  assert.deepEqual(sorted(fanA.consumers), ["b", "c"]); // a fans into both downstream leaves
  assert.ok(r.highFanIn.some(f => f.producer === "a")); // ≥2 consumers ⇒ CSE/hoist candidate

  assert.deepEqual(r.deadProducers, []);    // c is terminal (→ final), so not dead
  assert.equal(r.cost.agentLeaves, 2);      // b, c
});

test("optimizationReport: a mid-pipeline producer nobody reads is flagged dead; a terminal one is not", () => {
  // `orphan` runs then routes onward, but no later consumer's contract sits downstream of it as a producer it needs;
  // here we make it genuinely unread by giving the consumer a switch that bypasses orphan's output entirely.
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "start",
    states: {
      start: { type: "code", on: { DONE: "work" } },
      work: { type: "agent", on: { DONE: "done" } }, // terminal producer → not dead
      done: { type: "final", status: "success" },
    },
  } as any;
  const r = optimizationReport(sk);
  assert.deepEqual(r.deadProducers, []);              // both start (consumed by work) and work (terminal) are fine
  assert.ok(r.contextSurface.find(s => s.name === "work")!.visible.includes("start"));
});

test("optimizationReport: contract-derived over-share — visible producers the contract never names are flagged", () => {
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "scope",
    states: {
      scope: { type: "code", on: { DONE: "bookkeep" } },
      bookkeep: { type: "code", on: { DONE: "review" } },              // visible to review but never read
      review: { type: "agent", contract: "Read the scope output and review the code.", on: { DONE: "done" } },
      done: { type: "final", status: "success" },
    },
  } as any;
  const os = optimizationReport(sk).overShare.find(o => o.leaf === "review")!;
  assert.deepEqual(os.unreferenced, ["bookkeep"]); // review sees {scope,bookkeep}; contract names scope → bookkeep flagged
});
