import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";
import type { StateContext } from "../../src/runtime/types.js";

const silent = () => {};

// Fail-fast guard for the node:test runner: if a per-state timeout regresses and a hung step/branch never settles,
// the test would hang forever — this bound makes the runner kill and FAIL it instead. It is a test-harness backstop,
// generously above the real assertions (which expect interruption in <1.5s), NOT a tuning knob of the system.
const FAIL_FAST_MS = 8000;

// A code-state entry that hangs until its signal aborts — the canonical "stuck branch/step". If the per-state
// timeout's signal is NOT threaded into the composite's branch/step context, this never settles and the run hangs;
// the node:test `timeout` then fails the test instead of hanging forever. With the fix it aborts → routes TIMEOUT.
const hangUntilAbort = (c: StateContext) => new Promise<string>((_res, rej) => {
  if (c.signal?.aborted) return rej(new Error("aborted"));
  c.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
});

async function runWith(states: Record<string, any>, initial: string): Promise<"success" | "error"> {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-to-"));
  try {
    const pipe = definePipeline({ config: { target: dir }, cwd: dir, logsDir: resolve(dir, "logs"), initial, states });
    return await pipe.run(silent, { autoApprove: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loop timeoutMs aborts a hung step and routes TIMEOUT", { timeout: FAIL_FAST_MS }, async () => {
  const status = await runWith({
    loop: { type: "loop", steps: ["hang"], join: "after", max: 3, timeoutMs: 150, on: { TIMEOUT: "timedout" } },
    hang: { entry: async (c: StateContext) => hangUntilAbort(c), on: "after" },
    after:    { type: "final", status: "success" }, // reached only if the step never timed out
    timedout: { type: "final", status: "error" },   // the TIMEOUT route — what we expect
  }, "loop");
  assert.equal(status, "error"); // routed via TIMEOUT (the step's signal was aborted by the per-state timeout)
});

test("parallel timeoutMs aborts a hung branch and routes TIMEOUT", { timeout: FAIL_FAST_MS }, async () => {
  const status = await runWith({
    par: { type: "parallel", over: () => [0, 1], branch: "hang", join: "after", timeoutMs: 150, on: { TIMEOUT: "timedout" } },
    hang: { entry: async (c: StateContext) => hangUntilAbort(c), on: "after" },
    after:    { type: "final", status: "success" },
    timedout: { type: "final", status: "error" },
  }, "par");
  assert.equal(status, "error"); // the timeout's signal reached the branches; withStateTimeout reported TIMEOUT
});

// A real ~5s shell command (a hermetic `node -e` timer — no dependency on `sleep` being on PATH) in a branch
// under a composite timeoutMs. Because c.shell is async (spawn) and honors the abort signal, the composite timer
// fires at 200ms, kills the child, and the run routes TIMEOUT — well under 1s, not 5s. This is the scenario a
// synchronous execSync could never satisfy (it blocked the loop).
test("composite timeoutMs interrupts a real shell in a branch and routes TIMEOUT (<1s)", { timeout: FAIL_FAST_MS }, async () => {
  const t0 = Date.now();
  const status = await runWith({
    par:  { type: "parallel", over: () => [0], branch: "slow", join: "after", timeoutMs: 200, on: { TIMEOUT: "timedout" } },
    slow: { entry: async (c: StateContext) => (await c.shell('node -e "setTimeout(() => {}, 5000)"')) ? "DONE" : "FAIL", on: "after" },
    after:    { type: "final", status: "success" },
    timedout: { type: "final", status: "error" },
  }, "par");
  const elapsed = Date.now() - t0;
  assert.equal(status, "error");                 // routed via TIMEOUT (the shell was killed at the budget)
  assert.ok(elapsed < 1500, `expected interruption near 200ms, not the 5s sleep (took ${elapsed}ms)`);
});

// A branch STATE carries its OWN timeoutMs while the parallel container has none. executeStateOnce must honor it
// (chaining onto the composite signal): the branch's shell is killed at 200ms and the branch is marked failed,
// so the join's check routes to error — without the run waiting the full 5s.
test("a branch's own timeoutMs bounds it even with no container timeout", { timeout: FAIL_FAST_MS }, async () => {
  const t0 = Date.now();
  const status = await runWith({
    par:  { type: "parallel", over: () => [0], branch: "slow", join: "check", on: { TIMEOUT: "timedout" } },
    slow: { entry: async (c: StateContext) => (await c.shell('node -e "setTimeout(() => {}, 5000)"')) ? "DONE" : "FAIL", on: "check", timeoutMs: 200 },
    check:{ entry: async (c: StateContext) => ((c.data.branches as Array<{ ok: boolean }>).every((b) => b.ok) ? "DONE" : "FAIL"),
            on: { DONE: "after", FAIL: "timedout" } },
    after:    { type: "final", status: "success" },
    timedout: { type: "final", status: "error" },
  }, "par");
  const elapsed = Date.now() - t0;
  assert.equal(status, "error"); // the branch self-timed-out → marked failed → check routes error
  assert.ok(elapsed < 1500, `branch's own 200ms timeout should bound it, not the 5s sleep (took ${elapsed}ms)`);
});
