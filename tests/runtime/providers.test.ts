import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { piProvider, opencodeProvider, hermesProvider, resolveProvider, allProviders, type Provider } from "../../src/runtime/providers.js";
import { runAgent, type AgentRunConfig } from "../../src/runtime/agent.js";

const base: AgentRunConfig = { prompt: "/a/SYSTEM.md", task: "do it", cwd: "/tmp" };

// ── Pi argv (must be byte-identical to pre-refactor behavior) ──
test("pi oneshot: json mode + system-prompt + the three axes lower to Pi flags, then the task", () => {
  const a = piProvider.args("oneshot", { ...base, piModel: "anthropic/claude-haiku-4-5", appendPrompt: "/a/extra.md", skills: ["/s/x", "/s/y"] }, { path: "/a/SYSTEM.md" }, "do it");
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
  assert.deepEqual(piProvider.args("oneshot", base, { path: "/a/SYSTEM.md" }, "do it"), ["--mode", "json", "-p", "--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
});

test("pi rpc/interactive use their own base flags; neutral `model` wins over the legacy `piModel` alias", () => {
  assert.equal(piProvider.args("rpc", base, { path: "/a/SYSTEM.md" })[1], "rpc");
  assert.ok(!piProvider.args("rpc", base, { path: "/a/SYSTEM.md" }).includes("do it")); // rpc feeds the task via stdin frame
  assert.deepEqual(piProvider.args("interactive", base, { path: "/a/SYSTEM.md" }, "do it"), ["--no-session", "--system-prompt", "/a/SYSTEM.md", "do it"]);
  const a = piProvider.args("oneshot", { ...base, model: "n/new", piModel: "n/old" }, { path: "/a/SYSTEM.md" }, "t");
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--model"), ["n/new"]);
});

test("pi extensionArgs: a synthesized routine → .pi.mjs; a plain ext passes through", () => {
  const a = piProvider.extensionArgs!(["/t/parse_kv.routine.mjs", "/t/hand.mjs"], base);
  assert.deepEqual(a, ["--extension", "/t/parse_kv.pi.mjs", "--extension", "/t/hand.mjs"]);
});

// ── OpenCode argv ──
// Surfaces pinned to the released CLI (opencode-ai v1.18.13, packages/opencode/src/cli/cmd/run.ts).

test("opencode oneshot: headless run + json format + generated agent + --auto, then the task", () => {
  const a = opencodeProvider.args("oneshot", { ...base, piModel: "anthropic/claude-haiku-4-5" }, { path: "/a/SYSTEM.md" }, "do it");
  assert.deepEqual(a.slice(0, 4), ["run", "--format", "json", "--model"]);
  assert.ok(a.includes("reharness"));
  assert.ok(a.includes("--auto"));
  assert.equal(a.at(-1), "do it");
});

test("opencode oneshot: --auto is present (without it opencode AUTO-REJECTS every permission request)", () => {
  assert.ok(opencodeProvider.args("oneshot", base, { path: "/a/SYSTEM.md" }, "do it").includes("--auto"));
});

test("opencode interactive: the TUI is the bare command (no `run`, no --format)", () => {
  const a = opencodeProvider.args("interactive", base, { path: "/a/SYSTEM.md" }, "do it");
  assert.ok(!a.includes("run"));
  assert.ok(!a.includes("--format"));
  assert.ok(!a.includes("--auto")); // a human is present to answer permission prompts
});

// The TUI's positional is `[project]`, a PATH — a bare task there would be silently read as a directory.
test("opencode interactive: the task is seeded via --prompt, never as a positional", () => {
  const a = opencodeProvider.args("interactive", base, { path: "/a/SYSTEM.md" }, "do it");
  assert.deepEqual(a.slice(-2), ["--prompt", "do it"]);
  assert.equal(a.indexOf("do it"), a.length - 1, "the task must be --prompt's value, not a standalone positional");
});

test("opencode oneshot: the task IS the `run [message..]` positional", () => {
  const a = opencodeProvider.args("oneshot", base, { path: "/a/SYSTEM.md" }, "do it");
  assert.equal(a[a.length - 1], "do it");
  assert.ok(!a.includes("--prompt"), "`run` has no --prompt option");
});

test("opencode: prompt/skills lower through a generated config dir, not argv", () => {
  opencodeProvider.args("oneshot", { ...base, appendPrompt: "/a/extra.md", skills: ["/s/x"] }, { path: "/a/SYSTEM.md" }, "do it");
  // The args themselves don't carry the prompt path — prepare() stages it
  const p = opencodeProvider.prepare!("oneshot", { ...base, piModel: "m", appendPrompt: "/a/extra.md", skills: ["/s/x"] }, { path: "/a/SYSTEM.md" });
  const dir = p.env!.OPENCODE_CONFIG_DIR;
  assert.ok(dir && existsSync(dir));
  assert.equal(p.env!.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.agent.reharness.prompt, "{file:/a/SYSTEM.md}");
  assert.equal(cfg.agent.reharness.model, "m");
  assert.deepEqual(cfg.instructions, ["/a/extra.md", "/s/x"]);
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
});

test("opencode prepare: a synthesized routine becomes a globbed tool/<stem>.js shim importing the wrapper", () => {
  const p = opencodeProvider.prepare!("oneshot", { ...base, extensions: ["/t/parse_kv.routine.mjs"] }, { path: "/a/SYSTEM.md" });
  const dir = p.env!.OPENCODE_CONFIG_DIR;
  const shim = readFileSync(join(dir, "tool", "parse_kv.js"), "utf8");
  assert.match(shim, /from "\/t\/parse_kv\.opencode\.mjs"/);
  // `type: module` disambiguates the `.js` shim — without it the tool object lands at `default.default` (CJS interop)
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).type, "module");
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
});

// ── `session: "none"` — a backend with no in-session fix path must still run the validator (never a silent pass) ──

/** A fake backend binary that exits 0 without producing events. */
function fakeOkBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "rh-sessnone-"));
  const bin = join(dir, "fake.sh");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}

/** A minimal provider declaring the one strategy no shipped backend uses, so the driver's fallback path is covered. */
const noSessionProvider: Provider = {
  name: "fake-nosession",
  binary: "fake",
  install: "n/a",
  session: "none",
  stream: "text",
  args: (_mode, c) => [c.task],
  renderTool: () => [],
  normalize: () => [],
  frame: (m) => ({ message: m }),
};

test("session 'none': a passing validator lets a clean one-shot resolve", async () => {
  await runAgent({ prompt: "p", task: "t", cwd: tmpdir(), binary: fakeOkBin(), provider: noSessionProvider, validate: async () => [] });
});

test("session 'none': a failing validator throws instead of silently accepting the output", async () => {
  await assert.rejects(
    runAgent({ prompt: "p", task: "t", cwd: tmpdir(), binary: fakeOkBin(), provider: noSessionProvider, validate: async () => ["missing X"] }),
    /cannot self-correct in-session.*missing X/s,
  );
});

// The end-to-end contract: a bind-time-rendered wrapper, loaded through the staged shim the way opencode's tool
// registry loads it (dynamic import by file:// URL), must satisfy that registry's structural guard and execute.
test("opencode: the staged tool shim loads via file:// import and satisfies opencode's isPluginTool guard", async () => {
  const work = mkdtempSync(join(tmpdir(), "reharness-shimtest-"));
  writeFileSync(join(work, "parse_kv.routine.mjs"),
    `export const tool = { name: "parse_kv", description: "Parse k=v pairs", schema: { properties: { text: { type: "string" } } } };\n` +
    `export function run(a) { return Object.fromEntries(String(a.text).split(",").map((s) => s.split("="))); }\n`);
  for (const v of opencodeProvider.renderTool("parse_kv.routine.mjs")) writeFileSync(join(work, v.name), v.content);

  const p = opencodeProvider.prepare!("oneshot", { ...base, extensions: [join(work, "parse_kv.routine.mjs")] }, { path: "/a/SYSTEM.md" });
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
  const cfgA = { ...base, piModel: "m" };
  const a1 = opencodeProvider.prepare!("oneshot", cfgA, { path: "/a/SYSTEM.md" });
  const a2 = opencodeProvider.prepare!("oneshot", cfgA, { path: "/a/SYSTEM.md" });
  assert.equal(a1.env!.OPENCODE_CONFIG_DIR, a2.env!.OPENCODE_CONFIG_DIR);
  const b = opencodeProvider.prepare!("oneshot", { ...cfgA, piModel: "other" }, { path: "/a/SYSTEM.md" });
  assert.notEqual(b.env!.OPENCODE_CONFIG_DIR, a1.env!.OPENCODE_CONFIG_DIR);
  // cleanup must NOT delete the dir — the warm node_modules is the point
  a1.cleanup!();
  assert.ok(existsSync(a1.env!.OPENCODE_CONFIG_DIR));
  for (const d of [a1.env!.OPENCODE_CONFIG_DIR, b.env!.OPENCODE_CONFIG_DIR]) rmSync(d, { recursive: true, force: true });
});

test("opencode prepare: a changed toolset also re-keys the dir (no stale tool shims)", () => {
  const p1 = opencodeProvider.prepare!("oneshot", { ...base, extensions: ["/t/a.routine.mjs"] }, { path: "/a/SYSTEM.md" });
  const p2 = opencodeProvider.prepare!("oneshot", { ...base, extensions: ["/t/b.routine.mjs"] }, { path: "/a/SYSTEM.md" });
  assert.notEqual(p1.env!.OPENCODE_CONFIG_DIR, p2.env!.OPENCODE_CONFIG_DIR);
  for (const d of [p1.env!.OPENCODE_CONFIG_DIR, p2.env!.OPENCODE_CONFIG_DIR]) rmSync(d, { recursive: true, force: true });
});

test("opencode prepare: a session id lowers to --session for a resume turn", () => {
  const fresh = opencodeProvider.prepare!("oneshot", base, { path: "/a/SYSTEM.md" });
  assert.deepEqual(fresh.extraArgs, []);
  fresh.cleanup!();
  const resumed = opencodeProvider.prepare!("oneshot", base, { path: "/a/SYSTEM.md" }, "ses_abc");
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
  assert.equal(opencodeProvider.stream, "json");
});

// ── Hermes ──
// Surfaces pinned to hermes_cli/{main,oneshot}.py on main.

// `-z` is a TOP-LEVEL entry point taking the prompt as its value, NOT a `chat` flag: it bypasses the chat parser,
// so only -m/--provider/-t/--usage-file pass through. Skills must NOT appear on argv (see the skills test below).
test("hermes oneshot: top-level -z <task>, model as a flag, no chat subcommand", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-h-test-"));
  const sys = join(dir, "SYSTEM.md"); writeFileSync(sys, "BASE");
  const c = { ...base, prompt: sys, piModel: "hermes-4", skills: ["/s/x", "/s/y"], providerScratchDir: "" };
  const p = hermesProvider.prepare!("oneshot", c, { path: sys });
  const a = hermesProvider.args("oneshot", c, { path: sys }, "do it");
  assert.equal(a[0], "-z");
  assert.equal(a[1], "do it");
  assert.ok(a.includes("-m"));
  assert.ok(!a.includes("chat"), "-z bypasses the chat parser");
  assert.ok(!a.includes("-s"), "-s resolves names in hermes' own skills dir, not leaf paths");
  // --usage-file is staged by prepare(), not in args()
  assert.equal(p.extraArgs![0], "--usage-file");
  assert.equal(p.extraArgs!.length, 2);
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
});

test("hermes interactive: plain chat — no -z, and no -q (which would be non-interactive)", () => {
  const a = hermesProvider.args("interactive", base, { path: "/a/SYSTEM.md" });
  assert.deepEqual(a, ["chat"]);
  assert.ok(!a.includes("-q"), "-q answers once and exits; hermes has no seed-an-interactive-session flag");
});

test("hermes prepare: the system prompt + append + skills land in AGENTS.md (no --system-prompt flag exists)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-test-"));
  const sys = join(dir, "SYSTEM.md"), extra = join(dir, "extra.md");
  writeFileSync(sys, "BASE"); writeFileSync(extra, "MORE");
  const skill = join(dir, "skill.md"); writeFileSync(skill, "---\nname: x\n---\nSKILL BODY");
  const c = { ...base, prompt: sys, appendPrompt: extra, skills: [skill], providerScratchDir: "" };
  const p = hermesProvider.prepare!("oneshot", c, { path: sys });
  const scratch = c.providerScratchDir!;
  const agents = readFileSync(join(scratch, "AGENTS.md"), "utf-8");
  assert.match(agents, /BASE/);
  assert.match(agents, /MORE/);
  assert.match(agents, /SKILL BODY/);
  assert.ok(!agents.includes("name: x")); // frontmatter stripped
  p.cleanup!();
  rmSync(dir, { recursive: true, force: true });
});

test("hermes prepare: an unreadable prompt file degrades to backend defaults, never throws", () => {
  const c = { ...base, prompt: "/nope/missing.md", providerScratchDir: "" };
  const p = hermesProvider.prepare!("oneshot", c, { path: "/nope/missing.md" });
  // Should not throw, AGENTS.md may be empty or partial
  p.cleanup!();
});

test("hermes: no verifiable custom-tool path ⇒ renderTool is empty (the driver warns instead of inventing a flag)", () => {
  assert.deepEqual(hermesProvider.renderTool("parse_kv.routine.mjs"), []);
});

test("hermes prepare: stages --usage-file for oneshot; nothing in interactive; never a resume flag", () => {
  const c = { ...base, providerScratchDir: "" };
  const p = hermesProvider.prepare!("oneshot", c, { path: "/a/SYSTEM.md" });
  assert.deepEqual(p.extraArgs!.slice(0, 1), ["--usage-file"]);
  assert.equal(p.extraArgs!.length, 2, "no -r: resume is a chat flag and chat cannot write a usage file");
  p.cleanup!();
  const c2 = { ...base, providerScratchDir: "" };
  const i = hermesProvider.prepare!("interactive", c2, { path: "/a/SYSTEM.md" });
  assert.deepEqual(i.extraArgs, []);
  i.cleanup!();
});

test("hermes: text stream, and no in-session fix path (validate runs once, loud)", () => {
  assert.equal(hermesProvider.session, "none");
  assert.equal(hermesProvider.stream, "text");
});

test("hermes collectUsage: reads the usage file into session + usage events", () => {
  const c = { ...base, providerScratchDir: "" };
  const p = hermesProvider.prepare!("oneshot", c, { path: "/a/SYSTEM.md" });
  const usageFile = join(c.providerScratchDir!, "usage.json");
  writeFileSync(usageFile, JSON.stringify({
    estimated_cost_usd: 0.031, input_tokens: 12, output_tokens: 7,
    cache_read_tokens: 90, cache_write_tokens: 40, model: "hermes-4", session_id: "sess-9", completed: true,
  }));
  assert.deepEqual(p.collectUsage!(), [
    { kind: "session", id: "sess-9" },
    { kind: "usage", model: "hermes-4", tokensIn: 12, tokensOut: 7, cacheRead: 90, cacheWrite: 40, costUSD: 0.031 },
  ]);
  p.cleanup!();
});

test("hermes collectUsage: a missing usage file yields nothing rather than failing the leaf", () => {
  const c = { ...base, providerScratchDir: "" };
  const p = hermesProvider.prepare!("oneshot", c, { path: "/a/SYSTEM.md" });
  p.cleanup!();                       // removes the scratch dir before the read
  assert.deepEqual(p.collectUsage!(), []);
});

test("every provider declares install instructions and a session strategy", () => {
  for (const p of allProviders()) {
    assert.ok(typeof p.install === "string" && p.install.length > 0, `${p.name} must declare install`);
    assert.ok(typeof p.session === "string", `${p.name} must declare session strategy`);
    assert.ok(typeof p.stream === "string", `${p.name} must declare stream mode`);
  }
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
  assert.equal(resolveProvider("hermes"), hermesProvider);
  assert.equal(resolveProvider(undefined), piProvider);
  assert.throws(() => resolveProvider("gpt"), /Unknown provider "gpt".*opencode.*hermes/s);
});

test("allProviders returns every backend (used to render all variants at bind)", () => {
  assert.deepEqual(allProviders().map(p => p.name), ["pi", "opencode", "hermes"]);
});

// ── synthesized tools ──
test("renderTool: pi → .pi.mjs; opencode → .opencode.mjs wrapper; hermes → nothing (no plugin mechanism)", () => {
  const [pi] = piProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(pi.name, "parse_kv.pi.mjs");
  assert.match(pi.content, /registerTool/);
  const [oc] = opencodeProvider.renderTool("parse_kv.routine.mjs");
  assert.equal(oc.name, "parse_kv.opencode.mjs");
  assert.match(oc.content, /import \{ tool, run \} from ".\/parse_kv\.routine\.mjs"/);
  assert.deepEqual(hermesProvider.renderTool("parse_kv.routine.mjs"), []);
});

// ── driver: hermes validate leaf fails loud with session:none; spawnError carries the provider's install hint ──
test("runAgent: a validate leaf on hermes runs the validator once after one-shot (session: none)", async () => {
  // Hermes declares session: "none" — a validate leaf runs the validator ONCE after a successful one-shot.
  // A passing validator resolves; a failing one throws "cannot self-correct in-session".
  const bin = fakeOkBin();
  await runAgent({ prompt: "p", task: "t", cwd: tmpdir(), binary: bin, provider: hermesProvider, validate: async () => [] });
  await assert.rejects(
    runAgent({ prompt: "p", task: "t", cwd: tmpdir(), binary: bin, provider: hermesProvider, validate: async () => ["bad"] }),
    /cannot self-correct in-session.*bad/s,
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
  assert.ok(lines.some((l) => l.includes("cannot load synthesized tools") && l.includes("tool.routine.mjs")));
  assert.ok(!existsSync(join(dir, "tools"))); // nothing silently materialized
  rmSync(dir, { recursive: true, force: true });
});