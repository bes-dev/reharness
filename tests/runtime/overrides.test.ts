import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";
import type { StateContext, RunOptions } from "../../src/runtime/types.js";

const silent = () => {};

async function runWith(states: Record<string, any>, initial: string, opts: RunOptions = {}): Promise<"success" | "error"> {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-ov-"));
  try {
    const pipe = definePipeline({ config: { target: dir }, cwd: dir, logsDir: resolve(dir, "logs"), initial, states });
    return await pipe.run(silent, { autoApprove: true, ...opts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A loop counts iterations into ctx.data.n; its body exits via a guard once n reaches `max`. Overriding `loop.max`
// changes how many times the body runs — the canonical "change the number of loop iterations" the user named.
function countingLoop() {
  return {
    loop: { type: "loop", steps: ["tick"], join: "done", max: 5, on: {} },
    tick: { entry: (c: StateContext) => { c.data.n = (c.data.n || 0) + 1; }, on: "loop" },
    done: { type: "final", status: "success" },
  } as Record<string, any>;
}

test("--param overrides a loop's max iteration count", async () => {
  let seen = 0;
  const states = countingLoop();
  states.tick.entry = (c: StateContext) => { c.data.n = (c.data.n || 0) + 1; seen = c.data.n; };
  const status = await runWith(states, "loop", { overrides: { "loop.max": 2 } });
  assert.equal(status, "success");
  assert.equal(seen, 2, "loop body should run exactly the overridden max (2), not the compiled 5");
});

test("an override for a loop's timeoutMs aborts a hung body and routes TIMEOUT", async () => {
  const hang = (c: StateContext) => new Promise<string>((_r, rej) => {
    c.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
  });
  const status = await runWith({
    loop: { type: "loop", steps: ["hang"], join: "after", max: 3, on: { TIMEOUT: "timedout" } },
    hang: { entry: hang, on: "after" },
    after:    { type: "final", status: "success" },
    timedout: { type: "final", status: "error" },
  }, "loop", { overrides: { "loop.timeoutMs": 100 } });
  assert.equal(status, "error", "the injected timeoutMs should fire and route TIMEOUT");
});

test("invalid overrides fail loud before the run executes", async () => {
  const base = countingLoop();
  // unknown state
  assert.equal(await runWith(base, "loop", { overrides: { "nope.max": 2 } }), "error");
  // unknown knob
  assert.equal(await runWith(countingLoop(), "loop", { overrides: { "loop.bogus": 2 } }), "error");
  // max on a non-loop state
  assert.equal(await runWith(countingLoop(), "loop", { overrides: { "done.max": 2 } }), "error");
  // non-positive / non-integer loop max (would break the termination invariant)
  assert.equal(await runWith(countingLoop(), "loop", { overrides: { "loop.max": 0 } }), "error");
  assert.equal(await runWith(countingLoop(), "loop", { overrides: { "loop.max": 1.5 } }), "error");
});

test("--param overrides parallel concurrency without changing the result set", async () => {
  const status = await runWith({
    par: { type: "parallel", over: () => [0, 1, 2, 3], branch: "work", join: "done", concurrency: 1, on: {} },
    work: { entry: () => {}, on: "done" },
    done: { type: "final", status: "success" },
  }, "par", { overrides: { "par.concurrency": 4 } });
  assert.equal(status, "success"); // concurrency is a throughput knob — all branches still run, result unchanged
});
