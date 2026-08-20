import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { piProvider, opencodeProvider, resolveProvider, allProviders, type Provider } from "../../src/runtime/providers.js";
import { runAgent, type AgentRunConfig } from "../../src/runtime/agent.js";

const base: AgentRunConfig = { prompt: "/a/SYSTEM.md", task: "do it", cwd: "/tmp" };

// ── Pi argv (must be byte-identical to pre-refactor behavior) ──
test("pi oneshot: json mode + system-prompt + the three axes lower to Pi flags, then the task", () => {
  const a = piProvider.args("oneshot", { ...base, model: "anthropic/claude-haiku-4-5", appendPrompt: "/a/extra.md", skills: ["/s/x", "/s/y"] }, "do it");
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
  assert.deepEqual(piProvider.args("oneshot", base, "do it"), ["--mode", "json", "-p", "--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
});

test("pi rpc/interactive use their own base flags; neutral `model` wins over the legacy `piModel` alias", () => {
  assert.equal(piProvider.args("rpc", base)[1], "rpc");
  assert.ok(!piProvider.args("rpc", base).includes("do it")); // rpc feeds the task via stdin frame
  assert.deepEqual(piProvider.args("interactive", base, "do it"), ["--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
  const a = piProvider.args("oneshot", { ...base, model: "n/new", piModel: "n/old" }, "t");
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--model"), ["n/new"]);
});

test("pi extensionArgs: a synthesized routine → .pi.mjs; a plain ext passes through", () => {
  const a = piProvider.extensionArgs!(["/t/parse_kv.routine.mjs", "/t/hand.mjs"], base);
  assert.deepEqual(a, ["--extension", "/t/parse_kv.pi.mjs", "--extension", "/t/hand.mjs"]);
});

// ── OpenCode argv ──
// Surfaces pinned to the released CLI (opencode-ai v1.18.13, packages/opencode/src/cli/cmd/run.ts).

test("opencode oneshot: headless run + json format + generated agent + --auto, then the task", () => {
  const a = opencodeProvider.args("oneshot", { ...base, model: "anthropic/claude-haiku-4-5" }, "do it");
  assert.deepEqual(a.slice(0, 4), ["run", "--format", "json", "--model"]);
  assert.ok(a.includes("reharness"));
  assert.ok(a.includes("--auto"));
  assert.equal(a.at(-1), "do it");
});

test("opencode oneshot: --auto is present (without it opencode AUTO-REJECTS every permission request)", () => {
  assert.ok(opencodeProvider.args("oneshot", base, "do it").includes("--auto"));
});

test("opencode interactive: the TUI is the bare command (no `run`, no --format)", () => {
  const a = opencodeProvider.args("interactive", base, "do it");
  assert.ok(!a.includes("run"));
  assert.ok(!a.includes("--format"));
  assert.ok(!a.includes("--auto")); // a human is present to answer permission prompts
});

// The TUI's positional is `[project]`, a PATH — a bare task there would be silently read as a directory.
test("opencode interactive: the task is seeded via --prompt, never as a positional", () => {
  const a = opencodeProvider.args("interactive", base, "do it");
  assert.deepEqual(a.slice(-2), ["--prompt", "do it"]);
  assert.equal(a.indexOf("do it"), a.length - 1, "the task must be --prompt's value, not a standalone positional");
});

test("opencode oneshot: the task IS the `run [message..]` positional", () => {
  const a = opencodeProvider.args("oneshot", base, "do it");
  assert.equal(a[a.length - 1], "do it");
  assert.ok(!a.includes("--prompt"), "`run` has no --prompt option");
});

test("opencode: prompt/skills lower through a generated config dir, not argv", () => {
  opencodeProvider.args("oneshot", { ...base, appendPrompt: "/a/extra.md", skills: ["/s/x"] }, "do it");
  // The args themselves don't carry the prompt path — prepare() stages it
  const p = opencodeProvider.prepare!("oneshot", { ...base, model: "m", appendPrompt: "/a/extra.md", skills: ["/s/x"] });
  const dir = p.env!.OPENCODE_CONFIG_DIR;
  assert.ok(dir && existsSync(dir));
  assert.equal(p.env!.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.agent.reharness.prompt, "{file:/a/SYSTEM.md}");
  assert.equal(cfg.agent.reharness.model, "m");
  assert.deepEqual(cfg.instructions, ["/a/extra.md", "/s/x"]);
  assert.equal(p.cwd, dir);
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
});

test("opencode prepare: a synthesized routine becomes a globbed tool/<stem>.js shim importing the wrapper", () => {
  const p = opencodeProvider.prepare!("oneshot", { ...base, extensions: ["/t/parse_kv.routine.mjs"] });
  const dir = p.env!.OPENCODE_CONFIG_DIR;
  const shim = readFileSync(join(dir, "tool", "parse_kv.js"), "utf8");
  assert.match(shim, /from "\/t\/parse_kv\.opencode\.mjs"/);
  // `type: module` disambiguates the `.js` shim — without it the tool object lands at `default.default` (CJS interop)
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).type, "module");
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
});

// The end-to-end contract: a bind-time-rendered wrapper, loaded through the staged shim the way opencode's tool
// registry loads it (dynamic import by file:// URL), must satisfy that registry's structural guard and execute.
test("opencode: the staged tool shim loads via file:// import and satisfies opencode's isPluginTool guard", async () => {
  const work = mkdtempSync(join(tmpdir(), "reharness-shimtest-"));
  writeFileSync(join(work, "parse_kv.routine.mjs"),
    `export const tool = { name: "parse_kv", description: "Parse k=v pairs", schema: { properties: { text: { type: "string" } } } };\n` +
    `export function run(a) { return Object.fromEntries(String(a.text).split(",").map((s) => s.split("="))); }\n`);
  for (const v of opencodeProvider.renderTool("parse_kv.routine.mjs")) writeFileSync(join(work, v.name), v.content);

  const p = opencodeProvider.prepare!("oneshot", { ...base, extensions: [join(work, "parse_kv.routine.mjs")] });
  const dir = p.env!.OPENCODE_CONFIG_DIR;
  const mod = await import(pathToFileURL(join(dir, "tool", "parse_kv.js")).href);
  // opencode's guard, verbatim (packages/opencode/src/tool/registry.ts)
  const isPluginTool = (v: unknown) =>
    typeof v === "object" && v !== null && "args" in v && "description" in v && "execute" in v;
  assert.ok(isPluginTool(mod.default), "shim default export must be the tool descriptor, not a nested namespace");
  assert.equal(mod.default.description, "Parse k=v pairs");
  assert.deepEqual(Object.keys(mod.default.args), ["text"]); // JSON-Schema property map → legacyJsonSchema
  assert.equal(await mod.default.execute({ text: "a=1,b=2" }), JSON.stringify({ a: "1", b: "2" }));
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

// opencode fires a background `npm install @opencode-ai/plugin` into every config dir it loads and AWAITS it when a
// custom tool is present, so the dir is content-keyed and REUSED (cold install once) rather than mkdtemp'd per run.
test("opencode prepare: identical config ⇒ same dir (warm npm cache); changed config ⇒ a different dir", () => {
  const cfgA = { ...base, model: "m" };
  const a1 = opencodeProvider.prepare!("oneshot", cfgA);
  const a2 = opencodeProvider.prepare!("oneshot", cfgA);
  assert.equal(a1.env!.OPENCODE_CONFIG_DIR, a2.env!.OPENCODE_CONFIG_DIR);
  const b = opencodeProvider.prepare!("oneshot", { ...cfgA, model: "other" });
  assert.notEqual(b.env!.OPENCODE_CONFIG_DIR, a1.env!.OPENCODE_CONFIG_DIR);
  // cleanup must NOT delete the dir — the warm node_modules is the point
  a1.cleanup!();
  assert.ok(existsSync(a1.env!.OPENCODE_CONFIG_DIR));
  for (const d of [a1.env!.OPENCODE_CONFIG_DIR, b.env!.OPENCODE_CONFIG_DIR]) rmSync(d, { recursive: true, force: true });
});

test("opencode prepare: a changed toolset also re-keys the dir (no stale tool shims)", () => {
  const p1 = opencodeProvider.prepare!("oneshot", { ...base, extensions: ["/t/a.routine.mjs"] });
  const p2 = opencodeProvider.prepare!("oneshot", { ...base, extensions: ["/t/b.routine.mjs"] });
  assert.notEqual(p1.env!.OPENCODE_CONFIG_DIR, p2.env!.OPENCODE_CONFIG_DIR);
  for (const d of [p1.env!.OPENCODE_CONFIG_DIR, p2.env!.OPENCODE_CONFIG_DIR]) rmSync(d, { recursive: true, force: true });
});

test("opencode prepare: a session id lowers to --session for a resume turn", () => {
  const fresh = opencodeProvider.prepare!("oneshot", base);
  assert.deepEqual(fresh.extraArgs, []);
  fresh.cleanup!();
  const resumed = opencodeProvider.prepare!("oneshot", base, "ses_abc");
  assert.deepEqual(resumed.extraArgs, ["--session", "ses_abc"]);
  resumed.cleanup!();
});

test("opencode normalize: sessionID reported; tool states; step_finish tokens incl. cache; text/reasoning", () => {
  assert.deepEqual(opencodeProvider.normalize({ type: "text", sessionID: "s1", part: { text: "hi" } }),
    [{ kind: "session", id: "s1" }, { kind: "text", text: "hi" }]);
  assert.deepEqual(opencodeProvider.normalize({ type: "reasoning", part: { text: "hmm" } }), [{ kind: "thinking", text: "hmm" }]);
  // opencode emits `tool_use` ONLY for a settled part, so ONE event must yield BOTH halves — the start carrying the
  // args (the useful log line) and the end carrying the outcome. There is no pending/running emission to rely on.
  assert.deepEqual(opencodeProvider.normalize({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "/f" } } } }),
    [{ kind: "tool_start", name: "read", detail: "/f" }, { kind: "tool_end", name: "read", error: undefined }]);
  assert.deepEqual(opencodeProvider.normalize({ type: "tool_use", part: { tool: "bash", state: { status: "error", error: "boom", input: { command: "ls" } } } }),
    [{ kind: "tool_start", name: "bash", detail: "ls" }, { kind: "tool_end", name: "bash", error: "boom" }]);
  // StepFinishPart has NO model field, and --format json omits the message.updated line carrying modelID — so a
  // usage event must not claim one (the driver seeds the model from config instead).
  assert.deepEqual(opencodeProvider.normalize({ type: "step_finish", part: { reason: "stop", cost: 0.02, tokens: { input: 10, output: 5, cache: { read: 100, write: 200 } } } }),
    [{ kind: "usage", tokensIn: 10, tokensOut: 5, cacheRead: 100, cacheWrite: 200, costUSD: 0.02 }, { kind: "turn_end" }]);
  // mid-turn step: usage only, NO turn_end (the turn continues)
  const cont = opencodeProvider.normalize({ type: "step_finish", part: { reason: "tool-calls", cost: 0.001, tokens: { input: 1, output: 1, cache: {} } } });
  assert.equal(cont.length, 1);
});

test("opencode renderTool: an .opencode.mjs default-exporting {description,args,execute}", () => {
  const [t] = opencodeProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(t.name, "parse_kv.opencode.mjs");
  assert.match(t.content, /import \{ tool, run \} from ".\/parse_kv\.routine\.mjs"/);
  assert.match(t.content, /export default \{/);
  assert.match(t.content, /execute\(args\)/);
});

test("opencode: multi-turn is resume-based (no stdin protocol)", () => {
  assert.equal(opencodeProvider.session, "resume");
});

// ── event normalization fixtures: backend stream → the common vocabulary ──
test("pi normalize: tool/usage/text/turn-end; acks ⇒ nothing", () => {
  assert.deepEqual(piProvider.normalize({ type: "tool_execution_start", toolName: "Read", args: { path: "/f" } }), [{ kind: "tool_start", name: "Read", detail: "/f" }]);
  assert.deepEqual(piProvider.normalize({ type: "agent_end" }), [{ kind: "turn_end" }]);
  const me = piProvider.normalize({ type: "message_end", message: { role: "assistant", model: "m", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 200, cost: { total: 0.01 } }, content: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(me, [{ kind: "usage", model: "m", tokensIn: 10, tokensOut: 5, cacheRead: 100, cacheWrite: 200, costUSD: 0.01 }, { kind: "text", text: "hi" }]);
});

// ── RPC turn framing + registry ──
test("frame: pi uses {type:prompt}; opencode's is the pass-through turn marker", () => {
  assert.deepEqual(piProvider.frame("hello"), { type: "prompt", message: "hello" });
  assert.deepEqual(opencodeProvider.frame("hello"), { type: "prompt", message: "hello" });
});

test("resolveProvider: every backend maps; default is pi; unknown fails loud listing the registry", () => {
  assert.equal(resolveProvider("pi"), piProvider);
  assert.equal(resolveProvider("opencode"), opencodeProvider);
  assert.equal(resolveProvider(undefined), piProvider);
  assert.throws(() => resolveProvider("gpt"), /Unknown provider "gpt".*opencode/s);
});

test("allProviders returns every backend (used to render all variants at bind)", () => {
  assert.deepEqual(allProviders().map(p => p.name), ["pi", "opencode"]);
});

// ── synthesized tools ──
test("renderTool: pi → .pi.mjs; opencode → .opencode.mjs wrapper", () => {
  const [pi] = piProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(pi.name, "parse_kv.pi.mjs");
  assert.match(pi.content, /registerTool/);
  const [oc] = opencodeProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(oc.name, "parse_kv.opencode.mjs");
  assert.match(oc.content, /import \{ tool, run \} from ".\/parse_kv\.routine\.mjs"/);
});

// ── driver: spawnError carries the provider's install hint ──
test("runAgent: a missing binary fails with the provider's own install hint (opencode)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-spawnerr-"));
  const promptFile = join(dir, "SYSTEM.md"); writeFileSync(promptFile, "sys");
  const e = await runAgent({ prompt: promptFile, task: "t", cwd: dir, provider: opencodeProvider, binary: "/no/such/binary" }).then(() => "no-throw", (e: Error) => String(e));
  assert.match(e, /Backend 'opencode' not found/);
  assert.match(e, /opencode-ai/);
  rmSync(dir, { recursive: true, force: true });
});