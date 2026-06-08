import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";
import type { ExecResult } from "../../src/runtime/types.js";

const silent = () => {};
const NODE = process.execPath;

/** Run a one-state pipeline whose code state calls c.exec and captures the result. */
async function execProbe(cmd: string, args: string[], dryRun = false): Promise<ExecResult> {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-exec-"));
  let result: ExecResult | undefined;
  const pipe = definePipeline({
    config: { target: dir }, cwd: dir, logsDir: resolve(dir, "logs"), initial: "run",
    states: {
      run: { entry: async (c) => { result = await c.exec(cmd, args); return "DONE"; }, on: { DONE: "done", ERROR: "error" } },
      done: { type: "final", status: "success" },
      error: { type: "final", status: "error" },
    },
  });
  await pipe.run(silent, { dryRun });
  return result!;
}

test("c.exec returns stdout + exit 0 for a successful command", async () => {
  const r = await execProbe(NODE, ["-e", "process.stdout.write('hello')"]);
  assert.equal(r.ok, true);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "hello");
});

test("c.exec captures a non-zero exit code and stderr (no throw)", async () => {
  const r = await execProbe(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /boom/);
});

test("c.exec is STUBBED under --dry-run: clean success, no spawn (even of a missing binary)", async () => {
  const r = await execProbe("definitely-not-a-real-binary-xyz", ["--whatever"], /*dryRun*/ true);
  assert.equal(r.ok, true);          // stubbed success — a real spawn would have errored
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
