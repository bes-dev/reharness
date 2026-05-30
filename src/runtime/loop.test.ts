import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "./fsm.js";

const silent = () => {};

/** Build a pipeline with one loop whose step records data.iteration each round, then a join that records the
 *  post-loop data.iteration and data.iterations. Returns the recorded values. */
async function runLoopProbe(opts: { max?: number; exitAfter?: number }) {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-loop-"));
  const seenIndices: number[] = [];
  const captured: { afterIteration?: number; iterations?: number } = {};
  try {
    const pipe = definePipeline({
      config: { target: dir },
      cwd: dir,
      logsDir: resolve(dir, "logs"),
      initial: "loop",
      states: {
        loop: { type: "loop", steps: ["step"], join: "after", max: opts.max,
          exit: opts.exitAfter !== undefined ? (c) => c.data.iteration >= opts.exitAfter! : undefined },
        step: {
          entry: async (c) => {
            seenIndices.push(c.data.iteration);
            if (opts.exitAfter !== undefined && c.data.iteration >= opts.exitAfter) c.data.agreed = true;
            return "DONE";
          },
          on: "done",
        },
        after: {
          entry: async (c) => { captured.afterIteration = c.data.iteration; captured.iterations = c.data.iterations; return "DONE"; },
          on: { DONE: "done" },
        },
        done: { type: "final", status: "success" },
      },
    });
    const status = await pipe.run(silent, { autoApprove: true });
    return { status, seenIndices, ...captured };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2 loop counters: max=3 → indices 0,1,2; data.iterations=3 (the count)", async () => {
  const r = await runLoopProbe({ max: 3 });
  assert.equal(r.status, "success");
  assert.deepEqual(r.seenIndices, [0, 1, 2]);     // data.iteration is the 0-based COORDINATE inside the step
  assert.equal(r.iterations, 3);                   // data.iterations is the CARDINALITY after the loop
});

test("#2 data.iterations is the count, not iteration+1 (the off-by-one that broke nitpicker)", async () => {
  const r = await runLoopProbe({ max: 2 });
  assert.deepEqual(r.seenIndices, [0, 1]);
  assert.equal(r.iterations, 2);                   // would have been 3 under the old `data.iteration + 1`
  assert.equal(r.afterIteration, 1);              // after the loop, data.iteration = last index (not the count)
});

test("#2 exit predicate sees data.iteration as the index of the iteration that just ran", async () => {
  // exit when data.iteration >= 1 → runs index 0 (no exit), index 1 (exit) → 2 iterations.
  const r = await runLoopProbe({ max: 10, exitAfter: 1 });
  assert.deepEqual(r.seenIndices, [0, 1]);
  assert.equal(r.iterations, 2);
});
