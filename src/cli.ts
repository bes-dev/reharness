#!/usr/bin/env node

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
  const metaDir = resolve(__dirname, "meta");
  const metaCommands = getMetaCommands(metaDir);
  const project = await loadProject(root, metaCommands);

  if (!project || Object.keys(project.commands).length === 0) {
    console.error("No commands available.");
    console.error("Create .reharness/commands/ or use: reharness generate <description>");
    process.exit(1);
  }

  // No args → interactive TUI
  if (filteredArgs.length === 0) {
    await startTui(project, piModel, metaCommands);
    return;
  }

  // Direct command execution
  await runDirect(project, filteredArgs[0], filteredArgs.slice(1), piModel);
}

function printUsage() {
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";

  console.log(`${bold}reharness${reset} ${dim}— AI workflow compiler${reset}\n`);
  console.log(`${bold}Usage:${reset}`);
  console.log(`  ${cyan}reharness${reset}                        Interactive TUI`);
  console.log(`  ${cyan}reharness${reset} <command> [args...]     Run FSM pipeline directly\n`);
  console.log(`${bold}Built-in:${reset}`);
  console.log(`  ${cyan}generate${reset} [dir] <description>  Compile description → FSM`);
  console.log(`  ${cyan}evolve${reset}   [--interactive]       Improve FSM from run logs\n`);
  console.log(`${bold}Options:${reset}`);
  console.log(`  ${cyan}--model${reset} <id>     Model ${dim}(e.g. anthropic/claude-sonnet-4-6)${reset}`);
  console.log(`  ${cyan}--help${reset}            Show this help`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
