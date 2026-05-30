#!/usr/bin/env node
import "tsx/esm";

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadProject } from "./runtime/project.js";
import type { Pipeline, Project, RunOptions } from "./runtime/types.js";
import { runGenerate } from "./compiler/runner.js";
import { ansi, emit, formatDuration } from "./term.js";

// Read version from package.json at runtime — single source of truth.
const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")).version || "unknown"; }
  catch { return "unknown"; }
})();

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) { console.log(VERSION); process.exit(0); }
if (args.includes("--help") || args.includes("-h")) { printUsage(); process.exit(0); }

async function main() {
  let piModel: string | undefined, autoApprove = false, resume = false, fast = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && i + 1 < args.length) piModel = args[++i];
    else if (args[i] === "--auto-approve") autoApprove = true;
    else if (args[i] === "--resume") resume = true;
    else if (args[i] === "--fast" || args[i] === "--no-research") fast = true;
    else rest.push(args[i]);
  }

  const cwd = resolve(".");

  if (rest[0] === "generate") {
    process.exit(await runGenerate({ cwd, input: rest.slice(1).join(" "), autoApprove, piModel, fast }));
  }

  const project = await loadProject(cwd);
  if (!project || Object.keys(project.commands).length === 0) {
    console.error("No commands. Run `reharness generate <description>` to compile one.");
    process.exit(1);
  }

  if (rest.length === 0) { listCommands(project); process.exit(0); }

  const def = project.commands[rest[0]];
  if (!def) {
    console.error(`Unknown command: ${rest[0]}`);
    console.error(`Available: ${Object.keys(project.commands).join(", ")}`);
    process.exit(1);
  }

  const pipeline = def.run(rest.slice(1), { root: project.root, agents: project.agents, cwd: project.root });
  if (!pipeline?.run) { console.error(`"${rest[0]}" returned no pipeline`); process.exit(1); }

  process.exit(await runPipeline(pipeline, { resume, piModel }));
}

async function runPipeline(pipeline: Pipeline, opts: RunOptions): Promise<number> {
  process.on("SIGINT", () => { process.stdout.write("\r\x1b[K"); process.exit(130); });
  const start = Date.now();
  try {
    const status = await pipeline.run(emit, opts);
    process.stdout.write("\r\x1b[K");
    const elapsed = formatDuration(Date.now() - start);
    console.log(status === "success" ? ansi.green(`✓ done (${elapsed})`) : ansi.red(`✗ ${status} (${elapsed})`));
    return status === "success" ? 0 : 1;
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${ansi.red("✗ crashed:")} ${err.message}`);
    return 1;
  }
}

function listCommands(project: Project) {
  console.log(`${ansi.bold("reharness")} ${ansi.dim("— available commands")}\n`);
  for (const [name, def] of Object.entries(project.commands)) {
    const usage = def.usage ? ansi.dim(` ${def.usage}`) : "";
    console.log(`  ${ansi.cyan(name)}${usage}  ${ansi.dim(def.description)}`);
  }
}

function printUsage() {
  const { dim: d, bold: b, cyan: c } = ansi;
  console.log(`${b("reharness")} ${d(`v${VERSION} — conversational AI workflow compiler`)}

${b("Usage:")}
  ${c("reharness")}                          ${d("list compiled commands")}
  ${c("reharness <command> [args]")}         ${d("run a compiled workflow")}
  ${c("reharness generate <description>")}   ${d("compile a new workflow (approval checkpoint)")}
  ${c("reharness generate --auto-approve <description>")}  ${d("compile autonomously")}

${b("Options:")}
  ${c("--model")} <id>     ${d("LLM model (e.g. anthropic/claude-sonnet-4-6)")}
  ${c("--auto-approve")}   ${d("resolve approval checkpoints via auto-event")}
  ${c("--resume")}         ${d("resume the latest interrupted run")}
  ${c("--fast")}           ${d("skip web research in /generate (alias: --no-research)")}
  ${c("--version")}        ${d("print version and exit")}
  ${c("--help")}           ${d("this help")}`);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
