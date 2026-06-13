import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgent, type AgentRunConfig } from "../../src/runtime/agent.js";

/** A fake backend binary running an arbitrary sh `body` (so we can simulate a hung / runaway / over-budget leaf). */
function fakeBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-wd-"));
  const bin = join(dir, "fake.sh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const run = (bin: string, wd: Partial<AgentRunConfig>) =>
  runAgent({ prompt: "p", task: "t", cwd: tmpdir(), piBinary: bin, ...wd });

// A Pi usage event line worth $0.60 (message_end → normalize → usage{cost.total}).
const USAGE = `{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":10,"cost":{"total":0.6}}}}`;

test("idle watchdog kills a leaf that goes silent (L1 — waits on working, kills hung)", { timeout: 8000 }, async () => {
  // Emits one event (proving it CAN produce), then goes silent for 5s — a hung leaf.
  const bin = fakeBin(`echo '{}'\nsleep 5`);
  await assert.rejects(run(bin, { idleMs: 300 }), /killed.*stalled/s);
});

test("wall-clock ceiling kills a runaway leaf (L3 — non-extendable)", { timeout: 8000 }, async () => {
  const bin = fakeBin(`echo '{}'\nsleep 5`);
  await assert.rejects(run(bin, { maxMs: 300 }), /killed.*wall-clock ceiling/s);
});

test("cost ceiling kills an over-budget leaf (L3 — the solitaire backstop)", { timeout: 8000 }, async () => {
  // Three usage events = $1.80, then idles — must trip the $1.00 cost budget regardless of liveness.
  const bin = fakeBin(`printf '%s\\n' '${USAGE}'\nprintf '%s\\n' '${USAGE}'\nprintf '%s\\n' '${USAGE}'\nsleep 5`);
  await assert.rejects(run(bin, { maxUsd: 1.0 }), /killed.*cost budget/s);
});

test("a leaf that finishes within all limits is NOT killed (no false positives)", { timeout: 8000 }, async () => {
  const bin = fakeBin(`echo '{}'\nexit 0`);
  await run(bin, { idleMs: 5000, maxMs: 10000, maxUsd: 100, maxTokens: 100000 }); // resolves
});
