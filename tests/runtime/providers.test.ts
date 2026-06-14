import { test } from "node:test";
import assert from "node:assert/strict";
import { piProvider, resolveProvider, allProviders } from "../../src/runtime/providers.js";
import type { AgentRunConfig } from "../../src/runtime/agent.js";

const base: AgentRunConfig = { prompt: "/a/SYSTEM.md", task: "do it", cwd: "/tmp" };

// ── Pi argv (the original behavior — must be byte-identical to the pre-refactor harnessArgs/spawn) ──
test("pi oneshot: json mode + system-prompt + the three axes lower to Pi flags, then the task", () => {
  const a = piProvider.args("oneshot", { ...base, piModel: "anthropic/claude-haiku-4-5", appendPrompt: "/a/extra.md", skills: ["/s/x", "/s/y"], extensions: ["/x/web.ts"] });
  assert.deepEqual(a, [
    "--mode", "json", "-p", "--no-session",
    "--model", "anthropic/claude-haiku-4-5",
    "--system-prompt", "/a/SYSTEM.md",
    "--append-system-prompt", "/a/extra.md",
    "--skill", "/s/x", "--skill", "/s/y",
    "--extension", "/x/web.ts",
    "do it",
  ]);
});

test("pi oneshot: no harness ⇒ minimal spawn (backward compatible)", () => {
  assert.deepEqual(piProvider.args("oneshot", base), ["--mode", "json", "-p", "--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
});

test("pi rpc/interactive use their own base flags and the rpc path omits the task", () => {
  assert.equal(piProvider.args("rpc", base)[1], "rpc");
  assert.ok(!piProvider.args("rpc", base).includes("do it")); // rpc feeds the task via stdin frame, not argv
  assert.deepEqual(piProvider.args("interactive", base), ["--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
});

// ── event normalization: the backend stream → the common vocabulary ──
test("pi normalize: tool/usage/text/turn-end; acks ⇒ nothing", () => {
  assert.deepEqual(piProvider.normalize({ type: "tool_execution_start", toolName: "Read", args: { path: "/f" } }), [{ kind: "tool_start", name: "Read", detail: "/f" }]);
  assert.deepEqual(piProvider.normalize({ type: "agent_end" }), [{ kind: "turn_end" }]);
  assert.deepEqual(piProvider.normalize({ type: "response" }), []); // RPC ack
  const me = piProvider.normalize({ type: "message_end", message: { role: "assistant", model: "m", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 200, cost: { total: 0.01 } }, content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(me, [{ kind: "usage", model: "m", tokensIn: 10, tokensOut: 5, cacheRead: 100, cacheWrite: 200, costUSD: 0.01 }, { kind: "text", text: "hi" }]);
});

// ── RPC turn framing + registry ──
test("frame: pi uses {type:prompt}", () => {
  assert.deepEqual(piProvider.frame("hello"), { type: "prompt", message: "hello" });
});

test("resolveProvider: pi maps; default is pi; unknown fails loud", () => {
  assert.equal(resolveProvider("pi"), piProvider);
  assert.equal(resolveProvider(undefined), piProvider);
  assert.throws(() => resolveProvider("gpt"), /Unknown provider/);
});

// ── synthesized tools: one neutral routine, rendered + lowered for Pi ──
test("renderTool: pi → a .pi.mjs extension that imports the routine", () => {
  const [pi] = piProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(pi.name, "parse_kv.pi.mjs");
  assert.match(pi.content, /import \{ tool, run \} from ".\/parse_kv\.routine\.mjs"/);
  assert.match(pi.content, /registerTool/);
});

test("pi lowers a synthesized-routine extension to --extension <stem>.pi.mjs; a plain ext passes through", () => {
  const a = piProvider.args("oneshot", { ...base, extensions: ["/t/parse_kv.routine.mjs", "/t/hand.mjs"] });
  assert.ok(a.includes("--extension"));
  assert.ok(a.includes("/t/parse_kv.pi.mjs"));    // routine → its pi variant
  assert.ok(a.includes("/t/hand.mjs"));           // hand-written ext → passthrough
  assert.ok(!a.includes("/t/parse_kv.routine.mjs"));
});

test("allProviders returns every backend (used to render all variants at bind)", () => {
  assert.deepEqual(allProviders().map(p => p.name), ["pi"]);
});
