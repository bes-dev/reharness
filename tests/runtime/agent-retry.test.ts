import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgent } from "../../src/runtime/agent.js";
import { AGENT_RETRIES } from "../../src/config.js";

/** A fake backend binary: appends to a counter file, prints `stderr` to stderr, exits with `code`. Lets us assert
 *  the retry policy end-to-end without a real agent. */
function fakeBin(stderr: string, code: number): { bin: string; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "rh-agent-"));
  const counter = join(dir, "calls");
  const bin = join(dir, "fake.sh");
  writeFileSync(bin, `#!/bin/sh\necho x >> "${counter}"\necho ${JSON.stringify(stderr)} 1>&2\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(counter) ? readFileSync(counter, "utf-8").trim().split("\n").filter(Boolean).length : 0) };
}

const run = (bin: string) => runAgent({ prompt: "p", task: "t", cwd: tmpdir(), binary: bin });

test("a transient failure (429) is retried up to the budget, then fails loud", async () => {
  const f = fakeBin("Error: 429 rate limit exceeded", 1);
  await assert.rejects(run(f.bin), /Agent failed/);
  assert.equal(f.calls(), AGENT_RETRIES + 1, "one initial attempt + AGENT_RETRIES retries");
});

test("a content error (400) is NOT retried — fail fast", async () => {
  const f = fakeBin("Error: 400 invalid request", 1);
  await assert.rejects(run(f.bin), /Agent failed/);
  assert.equal(f.calls(), 1, "no retry on a deterministic error");
});

test("a clean exit runs exactly once", async () => {
  const f = fakeBin("", 0);
  await run(f.bin); // resolves
  assert.equal(f.calls(), 1);
});

test("a missing binary yields an actionable error, not a raw ENOENT", async () => {
  await assert.rejects(run("/no/such/reharness-binary-xyz"), /not found.*PATH/s);
});
