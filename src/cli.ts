#!/usr/bin/env node

// Register tsx loader so we can import .ts files from .pi-fsm/commands/ and pipeline.ts
import "tsx/esm";

import { resolve } from "path";
import { loadProject } from "./project.js";
import { startTui, runDirect } from "./tui-app.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

async function main() {
  const root = resolve(".");
  const project = await loadProject(root);

  if (!project) {
    console.error("No .pi-fsm/ directory or pipeline.ts found.");
    console.error("Create .pi-fsm/commands/ or a pipeline.ts file.");
    process.exit(1);
  }

  if (Object.keys(project.commands).length === 0) {
    console.error("No commands found in .pi-fsm/commands/.");
    process.exit(1);
  }

  // No args → interactive TUI
  if (args.length === 0) {
    await startTui(project);
    return;
  }

  // Direct: pi-fsm build feedwise ...
  const command = args[0];
  const commandArgs = args.slice(1);
  await runDirect(project, command, commandArgs);
}

function printUsage() {
  console.log("pi-fsm — Deterministic multi-agent pipeline framework\n");
  console.log("Usage:");
  console.log("  pi-fsm                        Interactive mode (TUI)");
  console.log("  pi-fsm <command> [args...]     Run a command directly\n");
  console.log("Project structure:");
  console.log("  .pi-fsm/commands/             Command files (auto-discovered)");
  console.log("  .pi-fsm/agents/               Agent prompts (.md)");
  console.log("  .pi-fsm/lib/                  Shared code\n");
  console.log("Options:");
  console.log("  --help            Show this help");
}

main();
