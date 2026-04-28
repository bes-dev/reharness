/**
 * Project discovery — finds .pi-fsm/ directory and loads commands.
 *
 * Discovery order:
 *   1. .pi-fsm/commands/*.ts  (new convention)
 *   2. pipeline.ts            (legacy fallback)
 */

import { existsSync, readdirSync, statSync } from "fs";
import { resolve, basename } from "path";
import type { Project, CommandDefinition, Pipeline } from "./types.js";

/** Discover a pi-fsm project from a starting directory. */
export async function loadProject(startDir: string): Promise<Project | null> {
  const commandsDir = resolve(startDir, ".pi-fsm", "commands");

  if (existsSync(commandsDir) && statSync(commandsDir).isDirectory()) {
    return loadFromPiFsmDir(startDir, commandsDir);
  }

  for (const name of ["pipeline.ts", "pipeline.js"]) {
    const path = resolve(startDir, name);
    if (existsSync(path)) {
      return loadFromPipelineFile(startDir, path);
    }
  }

  return null;
}

// ── .pi-fsm/ loader ────────────────────────────────────────────

async function loadFromPiFsmDir(root: string, commandsDir: string): Promise<Project> {
  const agentsDir = resolve(root, ".pi-fsm", "agents");
  const commands: Record<string, CommandDefinition> = {};

  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

  for (const file of files) {
    const fullPath = resolve(commandsDir, file);
    const name = basename(file).replace(/\.(ts|js)$/, "");

    try {
      const mod = await import(fullPath);
      if (mod?.default?.run) {
        commands[name] = mod.default as CommandDefinition;
      } else {
        console.error(`⚠ ${file}: missing default export with run() method, skipping`);
      }
    } catch (err: any) {
      console.error(`✗ Failed to load command "${name}": ${err.message}`);
    }
  }

  return { root, agents: agentsDir, commands };
}

// ── pipeline.ts adapter ────────────────────────────────────────

async function loadFromPipelineFile(root: string, path: string): Promise<Project> {
  let mod: any;
  try {
    mod = await import(path);
  } catch (err: any) {
    console.error(`Failed to load ${path}: ${err.message}`);
    return { root, agents: resolve(root, "agents"), commands: {} };
  }

  const handler = mod?.default;
  const rawCommands = mod?.commands as Record<string, string> | undefined;
  const agentsDir = resolve(root, "agents");
  const commands: Record<string, CommandDefinition> = {};

  if (rawCommands && typeof handler === "function") {
    for (const [spec, desc] of Object.entries(rawCommands)) {
      const name = spec.trim().split(/\s+/)[0];
      const usage = spec.includes("<") ? spec.slice(spec.indexOf("<")).trim() : undefined;
      commands[name] = {
        description: desc,
        usage,
        run: (args) => handler(name, args) as Pipeline | null,
      };
    }
  } else if (handler?.run) {
    commands["run"] = {
      description: "Run the pipeline",
      run: () => handler as Pipeline,
    };
  } else if (typeof handler === "function") {
    commands["run"] = {
      description: "Run the pipeline",
      usage: "<args...>",
      run: (args) => handler("run", args) as Pipeline | null,
    };
  }

  return { root, agents: agentsDir, commands };
}
