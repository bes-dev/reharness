import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";

test("error terminal surfaces ctx.data.error to the user (loud fail at the boundary)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-fail-"));
  const lines: string[] = [];
  const p = definePipeline({
    config: {},
    cwd: dir,
    logsDir: resolve(dir, "logs"),
    initial: "boom",
    states: {
      boom: { entry: async (c) => { c.data.error = "kaboom reason"; return "FAIL"; }, on: { FAIL: "error" } },
      error: { type: "final", status: "error" },
    },
  });
  try {
    const status = await p.run((m) => lines.push(m));
    assert.equal(status, "error");
    assert.ok(lines.some(l => l.includes("✗ failed: kaboom reason")), `expected the reason printed; got:\n${lines.join("\n")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("success terminal does NOT print a failure line", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-ok-"));
  const lines: string[] = [];
  const p = definePipeline({
    config: {},
    cwd: dir,
    logsDir: resolve(dir, "logs"),
    initial: "go",
    states: {
      go: { entry: async () => "DONE", on: { DONE: "done" } },
      done: { type: "final", status: "success" },
    },
  });
  try {
    const status = await p.run((m) => lines.push(m));
    assert.equal(status, "success");
    assert.ok(!lines.some(l => l.includes("✗ failed")), `unexpected failure line on success:\n${lines.join("\n")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
