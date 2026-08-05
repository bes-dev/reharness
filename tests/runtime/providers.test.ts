import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { piProvider, opencodeProvider, hermesProvider, resolveProvider, allProviders } from "../../src/runtime/providers.js";
import { runAgent } from "../../src/runtime/agent.js";
import type { AgentRunConfig } from "../../src/runtime/agent.js";

const promptContent = "You are the leaf.\nDo the work.\n";
const withPromptFile = (over: Partial<AgentRunConfig> = {}): AgentRunConfig => ({
  prompt: "/a/SYSTEM.md", task: "do it", cwd: "/tmp", ...over,
});
// the driver resolves PromptInput from the file; tests pass it directly
const P = { path: "/a/SYSTEM.md", content: promptContent };

// ── Pi argv (must be byte-identical to pre-refactor behavior) ──
test("pi oneshot: json mode + system-prompt + the three axes lower to Pi flags, then the task", () => {
  const a = piProvider.args("oneshot", withPromptFile({ piModel: "anthropic/claude-haiku-4-5", appendPrompt: "/a/extra.md", skills: ["/s/x", "/s/y"] }), P, "do it");
  assert.deepEqual(a, [
    "--mode", "json", "-p", "--no-session",
    "--model", "anthropic/claude-haiku-4-5",
    "--system-prompt", "/a/SYSTEM.md",
    "--append-system-prompt", "/a/extra.md",
    "--skill", "/s/x", "--skill", "/s/y",
    "do it",
  ]);
});

test("pi oneshot: no harness ⇒ minimal spawn (backward compatible)", () => {
  assert.deepEqual(piProvider.args("oneshot", withPromptFile(), P, "do it"), ["--mode", "json", "-p", "--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
});

test("pi rpc/interactive use their own base flags; neutral `model` wins over the legacy `piModel` alias", () => {
  assert.equal(piProvider.args("rpc", withPromptFile(), P)[1], "rpc");
  assert.ok(!piProvider.args("rpc", withPromptFile(), P).includes("do it")); // rpc feeds the task via stdin frame
  assert.deepEqual(piProvider.args("interactive", withPromptFile(), P, "do it"), ["--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
  const a = piProvider.args("oneshot", withPromptFile({ model: "n/new", piModel: "n/old" }), P, "t");
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--model"), ["n/new"]);
});

test("pi extensionArgs: a synthesized routine → .pi.mjs; a plain ext passes through", () => {
  const a = piProvider.extensionArgs!(["/t/parse_kv.routine.mjs", "/t/hand.mjs"], withPromptFile());
  assert.deepEqual(a, ["--extension", "/t/parse_kv.pi.mjs", "--extension", "/t/hand.mjs"]);
});

// ── OpenCode argv ──
const ocScratch = (): AgentRunConfig => {
  const dir = mkdtempSync(join(tmpdir(), "rh-oc-test-"));
  opencodeProvider.prepare!(dir, withPromptFile({ providerScratchDir: dir }), P);
  return withPromptFile({ providerScratchDir: dir });
};

test("opencode oneshot: run --format json --agent reharness; the prompt lands in the scratch agent definition", () => {
  const c = ocScratch();
  const a = opencodeProvider.args("oneshot", c, P, "do it");
  assert.deepEqual(a.slice(0, 4), ["run", "--format", "json", "--agent"]);
  assert.ok(a.includes("reharness"));
  assert.ok(a.includes("--dir") && a.includes("--auto"));
  assert.equal(a.at(-1), "do it");
  const def = readFileSync(join(c.providerScratchDir!, "agents", "reharness.md"), "utf-8");
  assert.match(def, /^---\nmode: primary\n---\n\nYou are the leaf\./);
  assert.ok(!def.includes("model:")); // no model configured ⇒ frontmatter omits it (user's opencode.json wins)
});

test("opencode oneshot: model + append + skills ride the agent file; the task prefixes the skill block", () => {
  const c = ocScratch();
  const extra = join(c.providerScratchDir!, "extra.md"); writeFileSync(extra, "EXTRA RULES");
  const skill = join(c.providerScratchDir!, "skill.md"); writeFileSync(skill, "---\nname: x\n---\nSKILL BODY");
  const a = opencodeProvider.args("oneshot", { ...c, model: "anthropic/claude-sonnet-4-6", appendPrompt: extra, skills: [skill] }, P, "do it");
  const def = readFileSync(join(c.providerScratchDir!, "agents", "reharness.md"), "utf-8");
  assert.match(def, /model: anthropic\/claude-sonnet-4-6/);
  assert.match(def, /EXTRA RULES/);
  const task = a.at(-1)!;
  assert.match(task, /\[Additional knowledge\]\nSKILL BODY/);
  assert.ok(!task.includes("name: x")); // frontmatter stripped
  assert.ok(task.endsWith("do it"));
});

test("opencode rpc: turn 1 spawns fresh; once a session id is captured, the next turn continues it", () => {
  const c = ocScratch();
  const t1 = opencodeProvider.args("rpc", c, P, "turn one");
  assert.ok(!t1.includes("--continue"));
  // a stream line carrying the session id
  opencodeProvider.normalize({ type: "step_start", sessionID: "ses_abc", timestamp: 1 }, c);
  const t2 = opencodeProvider.args("rpc", c, P, "turn two");
  assert.ok(t2.includes("--continue"));
  assert.deepEqual(t2.slice(t2.indexOf("--session"), t2.indexOf("--session") + 2), ["--session", "ses_abc"]);
});

test("opencode interactive: bare TUI with the prompt+task as --prompt prefill, no --agent", () => {
  const a = opencodeProvider.args("interactive", withPromptFile(), P, "do it");
  assert.equal(a[0], "--prompt");
  assert.match(a[1], /You are the leaf\./);
  assert.match(a[1], /do it/);
});

// ── Hermes argv ──
const hScratch = (): AgentRunConfig => {
  const dir = mkdtempSync(join(tmpdir(), "rh-h-test-"));
  const c = withPromptFile({ providerScratchDir: dir });
  hermesProvider.prepare!(dir, c, P);
  return c;
};

test("hermes oneshot: hermes -z <task> with hermetic flags + usage-file; the prompt lands in AGENTS.md", () => {
  const c = hScratch();
  const a = hermesProvider.args("oneshot", c, P, "do it");
  assert.equal(a[0], "-z");
  assert.equal(a[1], "do it");
  for (const f of ["--ignore-user-config", "--ignore-rules", "-y", "--max-turns", "--usage-file"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--usage-file") + 1], join(c.providerScratchDir!, "usage.json"));
  assert.match(readFileSync(join(c.providerScratchDir!, "AGENTS.md"), "utf-8"), /You are the leaf\./);
  assert.equal(hermesProvider.cwd!(c, P), c.providerScratchDir); // AGENTS.md auto-injection needs the scratch cwd
});

test("hermes oneshot: model via -m; interactive passes model+skill names", () => {
  const c = hScratch();
  const a = hermesProvider.args("oneshot", { ...c, model: "anthropic/claude-haiku-4-5" }, P, "t");
  assert.deepEqual(a.slice(a.indexOf("-m"), a.indexOf("-m") + 2), ["-m", "anthropic/claude-haiku-4-5"]);
  const i = hermesProvider.args("interactive", withPromptFile({ model: "m1", skills: ["sk"] }), withPromptFile() as any, undefined);
  assert.deepEqual(i, ["-m", "m1", "-s", "sk"]);
});

test("hermes declares modes without rpc; frame() throws the redirect message", () => {
  assert.deepEqual([...hermesProvider.modes!], ["oneshot", "interactive"]);
  assert.throws(() => hermesProvider.frame("x"), /does not support RPC\/validation/);
});

test("hermes normalize: no stream events by design; finalize reads the usage file", () => {
  const c = hScratch();
  assert.deepEqual(hermesProvider.normalize({ anything: 1 }), []);
  assert.deepEqual(hermesProvider.finalize!(c), []); // no usage.json yet ⇒ []
  writeFileSync(join(c.providerScratchDir!, "usage.json"), JSON.stringify({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 1000, cache_write_tokens: 50, estimated_cost_usd: 0.0042, model: "m" }));
  assert.deepEqual(hermesProvider.finalize!(c), [{ kind: "usage", model: "m", tokensIn: 100, tokensOut: 20, cacheRead: 1000, cacheWrite: 50, costUSD: 0.0042 }]);
});

// ── event normalization fixtures: backend stream → the common vocabulary ──
test("pi normalize: tool/usage/text/turn-end; acks ⇒ nothing", () => {
  assert.deepEqual(piProvider.normalize({ type: "tool_execution_start", toolName: "Read", args: { path: "/f" } }), [{ kind: "tool_start", name: "Read", detail: "/f" }]);
  assert.deepEqual(piProvider.normalize({ type: "agent_end" }), [{ kind: "turn_end" }]);
  assert.deepEqual(piProvider.normalize({ type: "response" }), []); // RPC ack
  const me = piProvider.normalize({ type: "message_end", message: { role: "assistant", model: "m", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 200, cost: { total: 0.01 } }, content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(me, [{ kind: "usage", model: "m", tokensIn: 10, tokensOut: 5, cacheRead: 100, cacheWrite: 200, costUSD: 0.01 }, { kind: "text", text: "hi" }]);
});

test("opencode normalize: tool_use (completed→start+end), step_finish→usage(+turn_end on stop), text, reasoning", () => {
  const tu = opencodeProvider.normalize({ type: "tool_use", sessionID: "s", part: { tool: "bash", state: { status: "completed", input: { command: "ls -la" } } } });
  assert.deepEqual(tu, [{ kind: "tool_start", name: "bash", detail: "ls -la" }, { kind: "tool_end", name: "bash", error: undefined }]);
  const bad = opencodeProvider.normalize({ type: "tool_use", part: { tool: "Read", state: { status: "error", error: "nope" } } });
  assert.deepEqual(bad[1], { kind: "tool_end", name: "Read", error: "nope" });
  const sf = opencodeProvider.normalize({ type: "step_finish", part: { reason: "stop", cost: 0.0023, tokens: { input: 5200, output: 310, reasoning: 0, cache: { read: 4100, write: 0 } } } });
  assert.deepEqual(sf, [
    { kind: "usage", tokensIn: 5200, tokensOut: 310, cacheRead: 4100, cacheWrite: 0, costUSD: 0.0023 },
    { kind: "turn_end" },
  ]);
  const cont = opencodeProvider.normalize({ type: "step_finish", part: { reason: "tool-calls", cost: 0.001, tokens: { input: 1, output: 1, cache: {} } } });
  assert.equal(cont.length, 1); // mid-turn step: usage only, NO turn_end (the turn continues)
  assert.deepEqual(opencodeProvider.normalize({ type: "text", part: { text: "final" } }), [{ kind: "text", text: "final" }]);
  assert.deepEqual(opencodeProvider.normalize({ type: "reasoning", part: { text: "hmm" } }), [{ kind: "thinking", text: "hmm" }]);
  assert.deepEqual(opencodeProvider.normalize({ type: "error", error: {} }), []); // exit code carries it
  assert.deepEqual(opencodeProvider.normalize({ type: "step_start", part: {} }), []);
});

// ── RPC turn framing + registry ──
test("frame: pi uses {type:prompt}; opencode's is the pass-through turn marker", () => {
  assert.deepEqual(piProvider.frame("hello"), { type: "prompt", message: "hello" });
  assert.deepEqual(opencodeProvider.frame("hello"), { type: "prompt", message: "hello" });
});

test("resolveProvider: every backend maps; default is pi; unknown fails loud listing the registry", () => {
  assert.equal(resolveProvider("pi"), piProvider);
  assert.equal(resolveProvider("opencode"), opencodeProvider);
  assert.equal(resolveProvider("hermes"), hermesProvider);
  assert.equal(resolveProvider(undefined), piProvider);
  assert.throws(() => resolveProvider("gpt"), /Unknown provider "gpt".*opencode.*hermes/s);
});

test("allProviders returns every backend (used to render all variants at bind)", () => {
  assert.deepEqual(allProviders().map(p => p.name), ["pi", "opencode", "hermes"]);
});

// ── synthesized tools ──
test("renderTool: pi → .pi.mjs; opencode → .opencode.ts zod wrapper; hermes → nothing (no plugin mechanism)", () => {
  const [pi] = piProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(pi.name, "parse_kv.pi.mjs");
  assert.match(pi.content, /registerTool/);
  const [oc] = opencodeProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(oc.name, "parse_kv.opencode.ts");
  assert.match(oc.content, /@opencode-ai\/plugin/);
  assert.match(oc.content, /from ".\/parse_kv\.routine\.mjs"/);
  assert.deepEqual(hermesProvider.renderTool("parse_kv.routine.mjs"), []);
});

// ── driver: hermes validate leaf fails LOUD pre-spawn; spawnError carries the provider's install hint ──
test("runAgent: a validate leaf on hermes rejects before spawning (RPC unsupported)", async () => {
  await assert.rejects(
    () => runAgent({ prompt: "/nonexistent.md", task: "t", cwd: "/tmp", provider: hermesProvider, validate: () => [] }),
    /Backend 'hermes' does not support RPC\/validation mode \(supported: oneshot, interactive\)/,
  );
});

test("runAgent: a missing binary fails with the provider's own install hint (opencode, hermes)", async () => {
  for (const [provider, hint] of [[opencodeProvider, "opencode-ai"], [hermesProvider, "hermes-agent.nousresearch.com"]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "rh-spawnerr-"));
    const promptFile = join(dir, "SYSTEM.md"); writeFileSync(promptFile, "sys");
    const e = await runAgent({ prompt: promptFile, task: "t", cwd: dir, provider, binary: "/no/such/binary" }).then(() => "no-throw", (e: Error) => String(e));
    assert.match(e, new RegExp(`Backend '${provider.name}' not found`));
    assert.match(e, new RegExp(hint.replace(/[.]/g, "\\.")));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgent: extensions on a backend without an extension axis degrade loudly, not silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-degrade-"));
  const promptFile = join(dir, "SYSTEM.md"); writeFileSync(promptFile, "sys");
  const lines: string[] = [];
  await runAgent({ prompt: promptFile, task: "t", cwd: dir, provider: hermesProvider, binary: "/no/such/binary", extensions: ["/x/tool.routine.mjs"], onLine: (m) => lines.push(m) }).catch(() => {});
  assert.ok(lines.some((l) => l.includes("no extension mechanism") && l.includes("tool.routine.mjs")));
  assert.ok(!existsSync(join(dir, "tools"))); // nothing silently materialized
  rmSync(dir, { recursive: true, force: true });
});
