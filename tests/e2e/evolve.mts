/**
 * End-to-end smoke for `evolve` — the LLM-backed demos, as reproducible artifacts.
 *
 * These are NOT in `npm test`: they spawn `pi` (a real model) and take ~1-2 min each. Run manually:
 *     npm run e2e            # all cases
 *     npm run e2e -- heal    # one case by name
 *
 * Each case builds a self-contained pipeline from scratch (codegen + a hand-filled lib), produces a run, then
 * runs `evolve` and asserts the machinery worked end-to-end. Credential-free (pure-local pipelines).
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = resolve(ROOT, "dist/cli.js");
const WORK = resolve(ROOT, "tests/e2e/.work");

const run = (cwd: string, ...args: string[]): { code: number; out: string } => {
  try { return { code: 0, out: execFileSync("node", [CLI, ...args], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 420_000 }) }; }
  catch (e: any) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};

/** Set up a fresh pipeline dir from an inline skeleton + lib (+ optional agent prompt), via the real codegen. */
async function setup(name: string, skeleton: string, lib: string, agent?: { leaf: string; prompt: string }): Promise<string> {
  const dir = resolve(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "reharness/skeletons"), { recursive: true });
  writeFileSync(resolve(dir, "reharness/skeletons", `${name}.xml`), skeleton);
  const { ensureESMPackage } = await import("../../dist/compiler/project-fs.js");
  const { generateAllFromSkeletons } = await import("../../dist/compiler/codegen.js");
  ensureESMPackage(dir, name);
  generateAllFromSkeletons(resolve(dir, "reharness"));
  writeFileSync(resolve(dir, "reharness/lib", `${name}-states.ts`), lib); // overwrite the stub with our (buggy) impl
  if (agent) { mkdirSync(resolve(dir, "reharness/agents", name, agent.leaf), { recursive: true }); writeFileSync(resolve(dir, "reharness/agents", name, agent.leaf, "SYSTEM.md"), agent.prompt); } // agents/<cmdId>/<leaf>/
  return dir;
}

const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(`ASSERT: ${msg}`); };

// ─────────────────────────────────────────────────────────────────────────────
// Case 1 — self-heal: a leaf bug (inverted existence check) that heal fixes + re-run confirms.
// ─────────────────────────────────────────────────────────────────────────────
const WORDCOUNT_SK = `<skeleton id="wordcount" initial="validate" format-version="0.5">
  <description>Count the words in a text file and write a short report.</description>
  <usage>&lt;file&gt;</usage>
  <inputs><arg name="file" positional="true" required="true" /></inputs>
  <state name="validate" type="code"><contract><![CDATA[Read config.file. If empty OR the file does NOT exist, set ctx.data.error and return INVALID. Otherwise set ctx.data.path to the resolved absolute path and return DONE.]]></contract>
    <on event="DONE" target="count" /><on event="INVALID" target="error" /></state>
  <state name="count" type="code" reads="data.path"><contract><![CDATA[Read the file at ctx.data.path; count whitespace tokens; write count.json {"words":N} to the output dir; return DONE.]]></contract>
    <on event="DONE" target="report" /></state>
  <state name="report" type="code"><contract><![CDATA[Read count.json from the count stage output dir; write report.txt "The file has <N> words." to the output dir; return DONE.]]></contract>
    <on event="DONE" target="done" /></state>
  <state name="done" type="final" status="success" /><state name="error" type="final" status="error" />
</skeleton>`;

const WORDCOUNT_LIB = `import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
export async function validateEntry(c: any): Promise<'DONE' | 'INVALID'> {
  const file: string = c.config?.file ?? '';
  if (!file) { c.data.error = 'no file given'; return 'INVALID'; }
  const path = resolve(file);
  // BUG (deliberate): inverted existence check — rejects files that DO exist. heal must fix this.
  if (existsSync(path)) { c.data.error = \`file does not exist: \${path}\`; return 'INVALID'; }
  c.data.path = path;
  return 'DONE';
}
export async function countEntry(c: any): Promise<'DONE'> {
  const words = readFileSync(c.data.path, 'utf-8').split(/\\s+/).filter(Boolean).length;
  writeFileSync(join(c.out(), 'count.json'), JSON.stringify({ words }));
  return 'DONE';
}
export async function reportEntry(c: any): Promise<'DONE'> {
  const { words } = JSON.parse(readFileSync(join(c.dir('count'), 'count.json'), 'utf-8'));
  writeFileSync(join(c.out(), 'report.txt'), \`The file has \${words} words.\`);
  return 'DONE';
}`;

async function caseHeal(): Promise<void> {
  const dir = await setup("wordcount", WORDCOUNT_SK, WORDCOUNT_LIB);
  writeFileSync(resolve(dir, "sample.txt"), "the quick brown fox jumps over the lazy dog\n");
  const r1 = run(dir, "wordcount", "sample.txt");
  assert(r1.code !== 0, "buggy wordcount should FAIL on a valid file");
  run(dir, "evolve");
  const r2 = run(dir, "wordcount", "sample.txt");
  assert(r2.code === 0, "after evolve self-heal, wordcount should SUCCEED on the same file");
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 2 — tool-gen: a leaf trace that re-derives a mechanical routine → extract a tool + bind it.
// ─────────────────────────────────────────────────────────────────────────────
const KVSTATS_SK = `<skeleton id="kvstats" initial="validate" format-version="0.5">
  <description>Parse a key=value config file and write a health summary.</description>
  <usage>&lt;file&gt;</usage>
  <inputs><arg name="file" positional="true" required="true" /></inputs>
  <state name="validate" type="code"><contract><![CDATA[Read config.file; INVALID if missing/not-exist; else copy its text to config.txt in the output dir and DONE.]]></contract>
    <on event="DONE" target="analyze" /><on event="INVALID" target="error" /></state>
  <state name="analyze" type="agent"><contract><![CDATA[Read config.txt from the validate output dir (key=value lines, '#' comments). Parse into pairs and write summary.md noting empty values, duplicate keys, and risky settings. Output only summary.md.]]></contract>
    <on event="DONE" target="done" /><on event="ERROR" target="error" /></state>
  <state name="done" type="final" status="success" /><state name="error" type="final" status="error" />
</skeleton>`;

const KVSTATS_LIB = `import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
export async function validateEntry(c: any): Promise<'DONE' | 'INVALID'> {
  const file: string = c.config?.file ?? '';
  if (!file || !existsSync(resolve(file))) { c.data.error = 'file missing'; return 'INVALID'; }
  writeFileSync(join(c.out(), 'config.txt'), readFileSync(resolve(file), 'utf-8'));
  return 'DONE';
}`;

const KVSTATS_PROMPT = `Read config.txt from the validate stage output dir (key=value lines with '#' comments). Parse it into pairs (split each non-comment line on the FIRST '=', trim), judge its health, and write summary.md (key count, empty values, duplicate keys, risky settings). Output ONLY summary.md.`;

// A stand-in trace: in a real run the analyze agent produces this; here we fabricate it so extract has a
// clear, repeated mechanical routine to amortize (the agent re-derives key=value parsing several times).
const KVSTATS_TRACE = `# Agent: analyze
# Task: parse config.txt and write summary.md
[thinking] I'll parse by hand: for each non-blank, non-'#' line, split on the FIRST '=' and trim key and value.
debug=true -> key 'debug', value 'true'. port=8080 -> 'port','8080'. name= -> 'name',''. port=9090 -> 'port','9090'.
[response] Count keys: re-parse each line, split on first '=', trim key -> distinct: debug, port, name -> 3.
[thinking] Empty values: parse again, split on first '=', trim value, collect empties -> name.
[thinking] Duplicates: parse once more, split on first '=', trim key, track repeats -> port.
[tool] write summary.md
[exit] code=0`;

async function caseToolgen(): Promise<void> {
  const dir = await setup("kvstats", KVSTATS_SK, KVSTATS_LIB, { leaf: "analyze", prompt: KVSTATS_PROMPT });
  writeFileSync(resolve(dir, "config.txt"), "# cfg\ndebug=true\nport=8080\nname=\nport=9090\n");
  // fabricate a successful execution run + the analyze trace (stand-in for a real agent run)
  const runDir = resolve(dir, "config-txt/logs/run-2020-01-01T00-00-00");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, "state.json"), JSON.stringify({ runId: "x", current: "__done__", data: {}, retries: {}, status: "success", argv: ["config.txt"] }));
  mkdirSync(resolve(runDir, "trace", "analyze"), { recursive: true }); // trace mirrors work/: trace/<stage>/NN-stage.md
  writeFileSync(resolve(runDir, "trace", "analyze", "01-analyze.md"), KVSTATS_TRACE);
  run(dir, "evolve");
  const toolsDir = resolve(dir, "reharness/tools/kvstats/analyze"); // tools are namespaced per command: tools/<cmdId>/<leaf>/
  const tools = existsSync(toolsDir) ? readdirSync(toolsDir).filter(f => f.endsWith(".mjs") && !f.endsWith(".test.mjs")) : [];
  assert(tools.length >= 1, "evolve should extract + bind at least one tool for the 'analyze' leaf");
  const harness = JSON.parse(readFileSync(resolve(dir, "reharness/agents/kvstats/analyze/harness.json"), "utf-8"));
  assert(Array.isArray(harness.extensions) && harness.extensions.length >= 1, "the tool should be bound in harness.json extensions");
}

// ─────────────────────────────────────────────────────────────────────────────
const CASES: Record<string, () => Promise<void>> = { heal: caseHeal, toolgen: caseToolgen };

const pick = process.argv.slice(2).filter(a => !a.startsWith("-"));
const names = pick.length ? pick : Object.keys(CASES);
mkdirSync(WORK, { recursive: true });
let failed = 0;
for (const n of names) {
  const fn = CASES[n];
  if (!fn) { console.error(`unknown case '${n}' (have: ${Object.keys(CASES).join(", ")})`); failed++; continue; }
  process.stdout.write(`\n▶ e2e:${n} … `);
  try { await fn(); console.log("✓ PASS"); }
  catch (e: any) { console.log(`✗ FAIL — ${e.message}`); failed++; }
}
console.log(`\n${names.length - failed}/${names.length} e2e cases passed`);
process.exit(failed ? 1 : 0);
