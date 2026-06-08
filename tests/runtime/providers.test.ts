import { test } from "node:test";
import assert from "node:assert/strict";
import { piProvider, claudeProvider, resolveProvider, allProviders } from "../../src/runtime/providers.js";
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

// ── Claude Code argv (the new backend) ──
test("claude oneshot: stream-json, anthropic/ prefix stripped, file-based prompts, axes remapped", () => {
  const a = claudeProvider.args("oneshot", { ...base, piModel: "anthropic/claude-sonnet-4-6", appendPrompt: "/a/extra.md", skills: ["/s/x"], extensions: ["/x/mcp.json"] });
  assert.deepEqual(a, [
    "-p", "--output-format", "stream-json", "--verbose",
    "--model", "claude-sonnet-4-6",                 // anthropic/ prefix stripped
    "--system-prompt-file", "/a/SYSTEM.md",         // our prompt is a FILE
    "--append-system-prompt-file", "/a/extra.md",
    "--append-system-prompt-file", "/s/x",          // knowledge axis → appended (no headless skill discovery)
    "--mcp-config", "/x/mcp.json",                  // capability axis → MCP server
    "do it",
  ]);
});

test("claude rpc: streaming input mode (the persistent multi-turn session), task via stdin", () => {
  const a = claudeProvider.args("rpc", base);
  assert.ok(a.includes("--input-format") && a.includes("stream-json"));
  assert.ok(a.includes("--output-format"));
  assert.ok(!a.includes("do it"));
});

// ── event normalization: each backend's stream → the common vocabulary ──
test("pi normalize: tool/usage/text/turn-end; acks ⇒ nothing", () => {
  assert.deepEqual(piProvider.normalize({ type: "tool_execution_start", toolName: "Read", args: { path: "/f" } }), [{ kind: "tool_start", name: "Read", detail: "/f" }]);
  assert.deepEqual(piProvider.normalize({ type: "agent_end" }), [{ kind: "turn_end" }]);
  assert.deepEqual(piProvider.normalize({ type: "response" }), []); // RPC ack
  const me = piProvider.normalize({ type: "message_end", message: { role: "assistant", model: "m", usage: { input: 10, output: 5, cost: { total: 0.01 } }, content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(me, [{ kind: "usage", model: "m", tokensIn: 10, tokensOut: 5, costUSD: 0.01 }, { kind: "text", text: "hi" }]);
});

test("claude normalize: assistant(tool/text/usage) + result(cumulative cost + turn-end)", () => {
  const asst = claudeProvider.normalize({ type: "assistant", message: { model: "claude-x", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }, { type: "text", text: "ok" }], usage: { input_tokens: 20, output_tokens: 7 } } });
  assert.deepEqual(asst, [
    { kind: "tool_start", name: "Bash", detail: "ls" },
    { kind: "text", text: "ok" },
    { kind: "usage", model: "claude-x", tokensIn: 20, tokensOut: 7, costUSD: 0 },
  ]);
  const res = claudeProvider.normalize({ type: "result", total_cost_usd: 0.5 });
  assert.deepEqual(res, [{ kind: "usage", tokensIn: 0, tokensOut: 0, costUSD: 0.5, costCumulative: true }, { kind: "turn_end" }]);
  assert.deepEqual(claudeProvider.normalize({ type: "system", subtype: "init" }), []);
});

// ── RPC turn framing + registry ──
test("frame: pi uses {type:prompt}, claude uses a user message", () => {
  assert.deepEqual(piProvider.frame("hello"), { type: "prompt", message: "hello" });
  assert.deepEqual(claudeProvider.frame("hello"), { type: "user", message: { role: "user", content: "hello" } });
});

test("resolveProvider: names map; default is pi; unknown fails loud", () => {
  assert.equal(resolveProvider("pi"), piProvider);
  assert.equal(resolveProvider("claude"), claudeProvider);
  assert.equal(resolveProvider(undefined), piProvider);
  assert.throws(() => resolveProvider("gpt"), /Unknown provider/);
});

// ── synthesized tools: one neutral routine, rendered per backend, lowered per backend ──
test("renderTool: pi → a .pi.mjs extension; claude → a .mcp.mjs server; both import the routine", () => {
  const [pi] = piProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(pi.name, "parse_kv.pi.mjs");
  assert.match(pi.content, /import \{ tool, run \} from ".\/parse_kv\.routine\.mjs"/);
  assert.match(pi.content, /registerTool/);
  const [mcp] = claudeProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(mcp.name, "parse_kv.mcp.mjs");
  assert.match(mcp.content, /import \{ tool, run \} from ".\/parse_kv\.routine\.mjs"/);
  assert.match(mcp.content, /"tools\/call"/); // a JSON-RPC MCP server
  assert.match(mcp.content, /jsonrpc/);
});

test("pi lowers a synthesized-routine extension to --extension <stem>.pi.mjs; a plain ext passes through", () => {
  const a = piProvider.args("oneshot", { ...base, extensions: ["/t/parse_kv.routine.mjs", "/t/hand.mjs"] });
  assert.ok(a.includes("--extension"));
  assert.ok(a.includes("/t/parse_kv.pi.mjs"));    // routine → its pi variant
  assert.ok(a.includes("/t/hand.mjs"));           // hand-written ext → passthrough
  assert.ok(!a.includes("/t/parse_kv.routine.mjs"));
});

test("claude lowers a synthesized-routine extension to an inline MCP config + allowlist", () => {
  const a = claudeProvider.args("oneshot", { ...base, extensions: ["/t/parse_kv.routine.mjs"] });
  const i = a.indexOf("--mcp-config");
  assert.ok(i >= 0);
  const cfg = JSON.parse(a[i + 1]);
  assert.deepEqual(cfg.mcpServers.parse_kv, { command: "node", args: ["/t/parse_kv.mcp.mjs"] });
  const j = a.indexOf("--allowedTools");
  assert.ok(j >= 0 && a[j + 1] === "mcp__parse_kv__parse_kv"); // headless requires the tool be allowed
});

test("allProviders returns every backend (used to render all variants at bind)", () => {
  const names = allProviders().map(p => p.name).sort();
  assert.deepEqual(names, ["claude", "pi"]);
});
