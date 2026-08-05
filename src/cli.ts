#!/usr/bin/env node
import "tsx/esm";

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadProject } from "./runtime/project.js";
import type { Pipeline, Project, RunOptions } from "./runtime/types.js";
import { runCompile, runAmend, runEvolve, runGraph, terminalApprovalHandler } from "./compiler/runner.js";
import { RESERVED_IDS } from "./compiler/schema.js";
import { ansi, emit, formatDuration } from "./term.js";

// Read version from package.json at runtime — single source of truth.
const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")).version || "unknown"; }
  catch { return "unknown"; }
})();

// ── The CLI surface, declared ONCE. The parser, the dispatch, the help text and the no-arg listing are all DERIVED
//    from these two tables — add a verb/flag here and it shows up everywhere automatically (no hand-synced lists). ──

/** Parsed flags. Verb handlers read what they need from this bag. */
interface Opts {
  piModel?: string; provider?: string; name?: string; fromSession?: string; fromHarness?: string; out?: string;
  autoApprove: boolean; resume: boolean; fast: boolean; noEnhance: boolean; evolveAfter: boolean; html: boolean; dryRun: boolean;
  flagParams: Record<string, number>; fileParams: Record<string, number>; // --param wins over a --params profile
}

interface Verb {
  name: string; usage: string; desc: string;
  run: (rest: string[], cwd: string, o: Opts, overrides: Record<string, number>) => Promise<number>;
}

const VERBS: Verb[] = [
  { name: "compile", usage: "<description>", desc: "compile a new workflow from a description (approval checkpoint; --auto-approve / --from-session)",
    run: (rest, cwd, o, overrides) => runCompile({ cwd, input: rest.join(" "), autoApprove: o.autoApprove, piModel: o.piModel, fast: o.fast, noEnhance: o.noEnhance, name: o.name, fromSession: o.fromSession, fromHarness: o.fromHarness, overrides, provider: o.provider }) },
  { name: "amend", usage: "[<command>] <request>", desc: "amend a compiled command with a new feature (name the command if several)",
    run: (rest, cwd, o, overrides) => runAmend({ cwd, input: rest.join(" "), autoApprove: o.autoApprove, piModel: o.piModel, fast: o.fast, noEnhance: o.noEnhance, overrides, provider: o.provider }) },
  { name: "evolve", usage: "[<command>]", desc: "learn from the last run: self-heal failures, amortize routines into tools, refine skills",
    run: (rest, cwd, o, overrides) => runEvolve({ cwd, piModel: o.piModel, command: rest[0], overrides, provider: o.provider }) },
  { name: "graph", usage: "[<command>] [--html]", desc: "render a compiled command's FSM to a file: <command>.mmd, or <command>.html with --html",
    run: (rest, cwd, o) => runGraph({ cwd, command: rest[0], html: o.html, out: o.out }) },
];

// Invariant: every built-in verb is a reserved skeleton id, so a compiled command can't shadow it (the compiler
// rejects the name at lint). Fail loud here if the two sources drift apart.
for (const v of VERBS) if (!RESERVED_IDS.has(v.name)) throw new Error(`Built-in verb '${v.name}' is not in RESERVED_IDS (src/compiler/schema.ts) — a project command could shadow it.`);

interface Opt { names: string[]; arg?: string; desc: string; apply: (o: Opts, v: string) => void }

const OPTIONS: Opt[] = [
  { names: ["--model"], arg: "<id>", desc: "LLM model (e.g. anthropic/claude-sonnet-4-6)", apply: (o, v) => { o.piModel = v; } },
  { names: ["--provider"], arg: "<id>", desc: "agent backend: pi | opencode | hermes (default: pi; hermes is oneshot/interactive only)", apply: (o, v) => { o.provider = v; } },
  { names: ["--name"], arg: "<name>", desc: "name the compiled command yourself (compile only; default: auto-derived)", apply: (o, v) => { o.name = v; } },
  { names: ["--from-session"], arg: "<path>", desc: "compile from a recorded session file/dir (with compile)", apply: (o, v) => { o.fromSession = v; } },
  { names: ["--from-harness"], arg: "<dir>", desc: "compile from an existing harness/implementation directory (research explores it in place)", apply: (o, v) => { o.fromHarness = v; } },
  { names: ["-o", "--output"], arg: "<file>", desc: "graph: output filename (default <command>.mmd/.html; `-` = stdout)", apply: (o, v) => { o.out = v; } },
  { names: ["--auto-approve"], desc: "resolve approval checkpoints via auto-event", apply: (o) => { o.autoApprove = true; } },
  { names: ["--resume"], desc: "resume the latest interrupted run", apply: (o) => { o.resume = true; } },
  { names: ["--fast", "--no-research"], desc: "skip web research in compile/amend", apply: (o) => { o.fast = true; } },
  { names: ["--no-enhance"], desc: "skip the auto-chained enhance layer after compile/amend", apply: (o) => { o.noEnhance = true; } },
  { names: ["--evolve"], desc: "after running a command, auto-chain evolve on its verdict", apply: (o) => { o.evolveAfter = true; } },
  { names: ["--dry-run"], desc: "run a command WITHOUT spawning agents/shells — smoke-test routing & data flow (no tokens)", apply: (o) => { o.dryRun = true; } },
  { names: ["--html"], desc: "graph: emit a self-contained interactive viewer instead of Mermaid", apply: (o) => { o.html = true; } },
  { names: ["--param"], arg: "<s.k=v>", desc: "override a pipeline knob for this run: state.{max|concurrency|timeoutMs|idleMs|maxMs|maxUsd|maxTokens}=<number> (repeatable)", apply: (o, v) => addParam(o.flagParams, v) },
  { names: ["--params"], arg: "<file>", desc: "load a JSON profile of overrides ({ \"state.knob\": number }); --param flags win over it", apply: (o, v) => Object.assign(o.fileParams, loadParamsFile(v)) },
];

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) { console.log(VERSION); process.exit(0); }
if (args.includes("--help") || args.includes("-h")) { printUsage(); process.exit(0); }

async function main() {
  const o: Opts = { autoApprove: false, resume: false, fast: false, noEnhance: false, evolveAfter: false, html: false, dryRun: false, flagParams: {}, fileParams: {} };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const opt = OPTIONS.find(x => x.names.includes(args[i]));
    if (!opt) { rest.push(args[i]); continue; }
    if (opt.arg) {
      if (i + 1 >= args.length) { console.error(`Missing value for ${args[i]} (expected ${opt.arg})`); process.exit(1); }
      opt.apply(o, args[++i]);
    } else opt.apply(o, "");
  }
  const overrides: Record<string, number> = { ...o.fileParams, ...o.flagParams };
  const cwd = resolve(".");

  // Built-in verbs (single source: VERBS). Dispatched before loadProject so they work without a runnable project.
  const verb = VERBS.find(v => v.name === rest[0]);
  if (verb) process.exit(await verb.run(rest.slice(1), cwd, o, overrides));

  const project = await loadProject(cwd);
  if (!project || Object.keys(project.commands).length === 0) {
    console.error("No compiled commands here. Compile one:");
    console.error(`  ${ansi.cyan("reharness compile")} ${ansi.dim("<description>")}`);
    console.error(`\n${builtinHint()}`);
    process.exit(1);
  }

  if (rest.length === 0) { listCommands(project); process.exit(0); }

  const def = project.commands[rest[0]];
  if (!def) {
    console.error(`Unknown command: ${rest[0]}`);
    console.error(`Available: ${Object.keys(project.commands).join(", ")}   ${builtinHint()}`);
    process.exit(1);
  }

  const pipeline = def.run(rest.slice(1), { root: project.root, agents: project.agents, cwd: project.root });
  if (!pipeline?.run) { console.error(`"${rest[0]}" returned no pipeline`); process.exit(1); }

  // Approvals in a compiled command resolve via --auto-approve (auto-event) or, interactively, the terminal
  // handler — without either, an `approval` node fails loud. Both are wired here so a compiled pipeline with
  // human checkpoints runs in both modes (previously only the compiler pipeline's approvals were handled).
  const code = await runPipeline(pipeline, { resume: o.resume, piModel: o.piModel, overrides, provider: o.provider, dryRun: o.dryRun, autoApprove: o.autoApprove, approvalHandler: terminalApprovalHandler });
  // Continuous loop (opt-in): every run already persists a verdict; with --evolve, act on it now (self-heal /
  // amortize / refine). Off by default — evolve spawns agents, so acting every run is opt-in for cost.
  if (o.evolveAfter) await runEvolve({ cwd, piModel: o.piModel, command: rest[0], overrides, provider: o.provider });
  process.exit(code);
}

/** Parse one `--param state.knob=value` flag into the overrides map (value must be numeric). */
function addParam(into: Record<string, number>, spec: string): void {
  const eq = spec.indexOf("=");
  const v = Number(spec.slice(eq + 1));
  if (eq < 1 || !Number.isFinite(v)) { console.error(`Invalid --param "${spec}" — expected state.knob=<number>`); process.exit(1); }
  into[spec.slice(0, eq).trim()] = v;
}

/** Load a `--params <file.json>` profile: a flat { "state.knob": number } map (individual --param flags win over it). */
function loadParamsFile(path: string): Record<string, number> {
  try { return JSON.parse(readFileSync(resolve(path), "utf-8")); }
  catch (e: any) { console.error(`Cannot read --params "${path}": ${e.message}`); process.exit(1); }
}

async function runPipeline(pipeline: Pipeline, opts: RunOptions): Promise<number> {
  process.on("SIGINT", () => { process.stdout.write("\r\x1b[K"); process.exit(130); });
  const start = Date.now();
  try {
    const status = await pipeline.run(emit, opts);
    process.stdout.write("\r\x1b[K");
    const elapsed = formatDuration(Date.now() - start);
    console.log(status === "success" ? ansi.green(`✓ done (${elapsed})`) : ansi.red(`✗ failed (${elapsed})`));
    return status === "success" ? 0 : 1;
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${ansi.red("✗ crashed:")} ${err.message}`);
    return 1;
  }
}

interface Row { label: string; desc: string }

/** Render rows as an aligned two-column table (cyan label, dim description). Pass `width` to align several groups.
 *  A hoisted declaration — `printUsage` runs from the early `--help` check, before `const`s would be initialized. */
function column(rows: Row[], width = Math.max(...rows.map(r => r.label.length))): string {
  return rows.map(r => `  ${ansi.cyan(r.label.padEnd(width))}  ${ansi.dim(r.desc)}`).join("\n");
}

/** Terse built-in pointer for error contexts (unknown command / empty project) where a full table would be noise. */
const builtinHint = (): string =>
  `${ansi.dim("Built-in:")} ${VERBS.map(v => v.name).join(ansi.dim(" · "))}   ${ansi.dim("(reharness --help)")}`;

function listCommands(project: Project) {
  // Two distinct namespaces, kept visually separate: this env's compiled commands vs reharness's own toolchain.
  const proj: Row[] = Object.entries(project.commands).map(([name, def]) => ({ label: def.usage ? `${name} ${def.usage}` : name, desc: def.description }));
  const built: Row[] = VERBS.map(v => ({ label: `${v.name} ${v.usage}`.trim(), desc: v.desc }));
  const w = Math.max(...[...proj, ...built].map(r => r.label.length)); // one column width across both groups
  console.log(`${ansi.bold("reharness")} ${ansi.dim("— a reasoning compiler")}\n`);
  console.log(`${ansi.bold("Project commands:")} ${ansi.dim("— compiled in this env")}`);
  console.log(column(proj, w));
  console.log(`\n${ansi.bold("Built-in commands:")} ${ansi.dim("— the reharness toolchain")}`);
  console.log(column(built, w));
  console.log(`\n${ansi.dim("run `reharness --help` for options")}`);
}

function printUsage() {
  const runRows: Row[] = [
    { label: "reharness", desc: "list this env's commands" },
    { label: "reharness <command> [args]", desc: "run a project command" },
  ];
  const verbRows: Row[] = VERBS.map(v => ({ label: `reharness ${v.name} ${v.usage}`.trim(), desc: v.desc }));
  const optRows: Row[] = [
    ...OPTIONS.map(x => ({ label: `${x.names.join(", ")}${x.arg ? ` ${x.arg}` : ""}`, desc: x.desc })),
    { label: "--version", desc: "print version and exit" },
    { label: "--help", desc: "this help" },
  ];
  console.log(`${ansi.bold("reharness")} ${ansi.dim(`v${VERSION} — a reasoning compiler for AI agents`)}

${ansi.bold("Project commands:")} ${ansi.dim("— run a workflow compiled in this env")}
${column(runRows)}

${ansi.bold("Built-in commands:")} ${ansi.dim("— the reharness toolchain")}
${column(verbRows)}

${ansi.bold("Options:")}
${column(optRows)}`);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
