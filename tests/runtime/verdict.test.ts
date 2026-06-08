import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";

/** Read the single run's persisted state.json from a logsDir. */
function readVerdict(logsDir: string): any {
  const run = readdirSync(logsDir).filter(d => d.startsWith("run-")).sort().reverse()[0];
  return JSON.parse(readFileSync(resolve(logsDir, run, "state.json"), "utf-8"));
}

test("an error terminal persists status:'error' + the failing stage", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-verdict-"));
  const logsDir = resolve(dir, "logs");
  const p = definePipeline({
    config: {}, cwd: dir, logsDir, initial: "work",
    states: {
      work: { entry: async (c) => { c.data.error = "boom"; return "FAIL"; }, on: { FAIL: "error" } },
      error: { type: "final", status: "error" },
    },
  });
  try {
    assert.equal(await p.run(() => {}), "error");
    const v = readVerdict(logsDir);
    assert.equal(v.status, "error");
    assert.equal(v.failedStage, "work");       // the stage that emitted the failing event
    assert.equal(v.data.error, "boom");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a success terminal persists status:'success' and no failedStage", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-verdict-"));
  const logsDir = resolve(dir, "logs");
  const p = definePipeline({
    config: {}, cwd: dir, logsDir, initial: "go",
    states: {
      go: { entry: async () => "DONE", on: { DONE: "done" } },
      done: { type: "final", status: "success" },
    },
  });
  try {
    assert.equal(await p.run(() => {}), "success");
    const v = readVerdict(logsDir);
    assert.equal(v.status, "success");
    assert.equal(v.failedStage, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fully-deterministic (code-only) run records usage: 0 agents, $0 — the amortization invariant", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-verdict-"));
  const logsDir = resolve(dir, "logs");
  const p = definePipeline({
    config: {}, cwd: dir, logsDir, initial: "go",
    states: {
      go: { entry: async () => "DONE", on: { DONE: "done" } },
      done: { type: "final", status: "success" },
    },
  });
  try {
    await p.run(() => {});
    const v = readVerdict(logsDir);
    assert.deepEqual(v.usage, { costUSD: 0, tokensIn: 0, tokensOut: 0, agentRuns: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
