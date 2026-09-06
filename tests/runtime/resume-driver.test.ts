import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../../src/runtime/agent.js";
import type { Provider, NormEvent } from "../../src/runtime/providers.js";

/** A fake `session: "resume"` provider — the OpenCode shape in miniature: options first, the task as the
 *  variadic positional last, and `--session` (from `c.sessionId`, set by the resume driver on turn 2+) before
 *  it. No `prepare` — argv + inherited env is the whole contract. */
const resumeProvider: Provider = {
  name: "fakeresume",
  binary: "no-such-binary", // every test overrides via config.binary
  install: "(test stub)",
  session: "resume",
  args(mode, c, task) {
    const a = mode === "interactive" ? [] : ["run", "--format", "json"];
    if (c.sessionId) a.push("--session", c.sessionId);
    if (mode === "interactive") { if (task) a.push("--prompt", task); }
    else a.push(task ?? "");
    return a;
  },
  normalize(e) {
    const out: NormEvent[] = [];
    if (typeof e?.sessionID === "string" && e.sessionID) out.push({ kind: "session", id: e.sessionID });
    return out;
  },
  frame(message) { return { type: "prompt", message }; },
  renderTool() { return []; },
  extensionArgs: () => [],
};

/** Stub backend binary: one line per spawn in `<dir>/calls` (argv with newlines flattened, so a multi-line
 *  re-prompt task still counts as ONE line), then optionally one sessionID event, exit 0. */
function stubBin(withSession = true): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rh-resume-"));
  const log = join(dir, "calls");
  const bin = join(dir, "stub.sh");
  const emit = withSession ? `printf '%s\\n' '{"sessionID":"ses_stub"}'` : ":";
  writeFileSync(bin, `#!/bin/sh\necho "$*" | tr '\\n' ' ' >> "${log}"\necho >> "${log}"\n${emit}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

const cfg = (bin: string, validate: () => string[] | Promise<string[]>) => ({
  prompt: "p", task: "fix it", cwd: tmpdir(), provider: resumeProvider, binary: bin, validate,
});

test("resume: a passing validator finishes after ONE turn — one spawn, validator run exactly once", async () => {
  const s = stubBin();
  let validations = 0;
  await runAgent(cfg(s.bin, () => { validations++; return []; }));
  assert.equal(s.calls().length, 1, "clean first turn ⇒ exactly one spawn");
  assert.equal(validations, 1, "the validator must run exactly once (no caller-side double-run)");
  assert.ok(!s.calls()[0].includes("--session"), "turn 1 starts a fresh session (no --session)");
});

test("resume: a failing validator re-prompts into the SAME session (3 attempts), then fails loud", async () => {
  const s = stubBin();
  await assert.rejects(runAgent(cfg(s.bin, () => ["still broken"])), /Validation not satisfied after 3 attempt\(s\): still broken/);
  const calls = s.calls();
  assert.equal(calls.length, 4, "turn 1 + 3 fix attempts");
  assert.ok(!calls[0].includes("--session"), "turn 1 starts a fresh session");
  for (let i = 1; i < calls.length; i++)
    assert.ok(calls[i].includes("--session ses_stub"), `turn ${i + 1} must resume the captured session: ${calls[i]}`);
  assert.ok(calls[1].includes("failed validation"), "turn 2's task is the re-prompt with the errors, not the original task");
});

test("resume: NO session id + failing validator fails loud — never re-prompts into a fresh context", async () => {
  const s = stubBin(false); // emits no sessionID event
  await assert.rejects(runAgent(cfg(s.bin, () => ["still broken"])), /fakeresume' reported no session id to resume: still broken/);
  assert.equal(s.calls().length, 1, "without a session id there is nothing to resume — exactly one spawn, no re-prompt");
});

test("resume: NO session id + a PASSING validator still finishes clean (no resume needed)", async () => {
  const s = stubBin(false);
  await runAgent(cfg(s.bin, () => [])); // resolves
  assert.equal(s.calls().length, 1);
});
