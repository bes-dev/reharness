import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";

const silent = () => {};
const tmp = () => mkdtempSync(resolve(tmpdir(), "rh-pc-"));

// A parallel branch gets its OWN copy of ctx.data — concurrent branches (and nested composites under them) must
// not race on the scalar bus. These cover the parallel-over-composite topology that had no test before.

test("a parallel branch's ctx.data writes are branch-local (do not leak to the parent)", async () => {
  const dir = tmp();
  let captured: unknown;
  try {
    const pipe = definePipeline({
      config: { target: dir }, cwd: dir, logsDir: resolve(dir, "logs"),
      initial: "seed",
      states: {
        seed: { entry: async (c) => { c.data.x = "parent"; return "DONE"; }, on: { DONE: "par" } },
        par: { type: "parallel", over: () => [0, 1], branch: "b", join: "after" },
        // branch state: writes the shared key; run via executeStateOnce, its `on` is never followed (validation only).
        b: { entry: async (c) => { c.data.x = `branch${c.branchIndex}`; return "DONE"; }, on: { DONE: "after" } },
        after: { entry: async (c) => { captured = c.data.x; return "DONE"; }, on: { DONE: "done" } },
        done: { type: "final", status: "success" },
      },
    });
    const status = await pipe.run(silent, { autoApprove: true });
    assert.equal(status, "success");
    assert.equal(captured, "parent"); // branch writes were isolated; the parent's value survives the parallel
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parallel-over-loops: each branch's loop sees ONLY its own data.iteration (no cross-branch clobber)", async () => {
  const dir = tmp();
  const seen = new Map<string, number[]>();
  const rec = (k: string, v: number) => { (seen.get(k) ?? seen.set(k, []).get(k)!).push(v); };
  try {
    const pipe = definePipeline({
      config: { target: dir }, cwd: dir, logsDir: resolve(dir, "logs"),
      initial: "par",
      states: {
        par: { type: "parallel", over: () => ["a", "b"], branch: "loop", join: "after" },
        // each branch is a 3-iteration loop; its `join` is unused as a branch (validation only).
        loop: { type: "loop", steps: ["step"], join: "after", max: 3 },
        step: {
          entry: async (c) => {
            await new Promise((r) => setImmediate(r)); // yield so a sibling branch can advance its own loop
            rec(c.branchInput as string, c.data.iteration); // pre-isolation this could read a sibling's index
            return "DONE";
          },
          on: { DONE: "after" },
        },
        after: { entry: async () => "DONE", on: { DONE: "done" } },
        done: { type: "final", status: "success" },
      },
    });
    const status = await pipe.run(silent, { autoApprove: true });
    assert.equal(status, "success");
    assert.deepEqual(seen.get("a"), [0, 1, 2]); // branch a walked its own iterations, in order
    assert.deepEqual(seen.get("b"), [0, 1, 2]); // branch b likewise — no interleaved/clobbered index
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
