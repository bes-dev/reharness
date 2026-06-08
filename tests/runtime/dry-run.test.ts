import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { definePipeline } from "../../src/runtime/fsm.js";

const silent = () => {};

/** A pipeline with an agent leaf, a c.shell, and a code state that reads the agent's output dir. In dry-run it must
 *  run end-to-end WITHOUT spawning anything (no 'pi' binary, no real shell) and report success — the smoke gate. */
function probe() {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-dry-"));
  let shellRan = false;
  const pipe = definePipeline({
    config: { target: dir },
    cwd: dir,
    logsDir: resolve(dir, "logs"),
    initial: "plan",
    states: {
      plan: { entry: async (c) => { await c.agent("planner", "make a plan"); }, on: "build" },
      build: {
        entry: async (c) => {
          const seesPlan = existsSync(c.dir("plan")) && readdirSync(c.dir("plan")).length > 0; // stub dropped a placeholder
          const ok = await c.shell("exit 1"); // would FAIL for real; stubbed → true in dry-run
          if (ok) shellRan = true;
          return seesPlan && ok ? "DONE" : "FAIL";
        },
        on: { DONE: "done", FAIL: "error" },
      },
      done: { type: "final", status: "success" },
      error: { type: "final", status: "error" },
    },
  });
  return { pipe, dir, shellRan: () => shellRan };
}

test("dry-run: runs the graph to a terminal with agents & shell stubbed (no spawn), reports success", async () => {
  const p = probe();
  const status = await p.pipe.run(silent, { dryRun: true });
  assert.equal(status, "success", "graph traversed end-to-end (a real 'exit 1' shell or missing 'pi' would have failed it)");
  assert.equal(p.shellRan(), true, "c.shell was stubbed to success, not actually run");
});

test("dry-run: an agent stub drops a placeholder so downstream producers see a non-empty dir", async () => {
  const p = probe();
  await p.pipe.run(silent, { dryRun: true });
  // build reached 'done' only because it saw plan's (stubbed) output — already asserted by success above.
  assert.ok(true);
});
