#!/usr/bin/env node

// Register tsx loader so we can import .ts files from .pi-fsm/commands/ and pipeline.ts
import "tsx/esm";

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadProject } from "./core/project.js";
import { startTui, runDirect } from "./core/tui-app.js";
import { getMetaCommands } from "./meta/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

async function main() {
  // Parse global flags before routing
  let piModel: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && i + 1 < args.length) {
      piModel = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const root = resolve(".");

  // Meta commands (generate, evolve) — always available, survive project reload
  const metaDir = resolve(__dirname, "meta");
  const metaCommands = getMetaCommands(metaDir);

  const project = await loadProject(root, metaCommands);

  if (!project || Object.keys(project.commands).length === 0) {
    console.error("No commands available.");
    console.error("Create .pi-fsm/commands/ or use built-in: pi-fsm generate <dir> <description>");
    process.exit(1);
  }

  // No command args → interactive TUI
  if (filteredArgs.length === 0) {
    await startTui(project, piModel, metaCommands);
    return;
  }

  const command = filteredArgs[0];
  const commandArgs = filteredArgs.slice(1);
  await runDirect(project, command, commandArgs, piModel);
}

function printUsage() {
  console.log("pi-fsm — Deterministic multi-agent pipeline framework\n");
  console.log("Usage:");
  console.log("  pi-fsm                        Interactive mode (TUI)");
  console.log("  pi-fsm <command> [args...]     Run a command directly\n");
  console.log("Built-in commands:");
  console.log("  generate [dir] <description>  Generate a pipeline (standalone or in-project)");
  console.log("  evolve [--auto] [--interactive] Analyze logs, improve pipeline\n");
  console.log("Project structure:");
  console.log("  .pi-fsm/commands/             Command files (auto-discovered)");
  console.log("  .pi-fsm/agents/               Agent prompts (.md)");
  console.log("  .pi-fsm/lib/                  Shared code\n");
  console.log("Options:");
  console.log("  --model <id>      Pi model (e.g. anthropic/claude-sonnet-4-6)");
  console.log("  --help            Show this help");
}

main();
