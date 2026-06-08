import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";

/** `--resume` with no interrupted run must ANNOUNCE that it's starting fresh — not silently behave like a normal
 *  run (a typo'd command or an already-completed run should be visible, per fail-loud). */
test("resume with nothing to resume announces a fresh start (not silent)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-resume-"));
  const lines: string[] = [];
  const pipe = definePipeline({
    config: { target: dir }, cwd: dir, logsDir: resolve(dir, "logs"),
    initial: "done", states: { done: { type: "final", status: "success" } },
  });
  const status = await pipe.run((m) => lines.push(m), { resume: true });
  assert.equal(status, "success", "still runs (starts fresh)");
  assert.ok(lines.some((l) => /--resume.*no interrupted run/.test(l)), `expected a resume-fallthrough notice, got:\n${lines.join("\n")}`);
});
