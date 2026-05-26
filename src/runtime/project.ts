import { existsSync, readdirSync, statSync } from "fs";
import { resolve, basename } from "path";
import type { Project, CommandDefinition } from "./types.js";

/** Load all command modules from `<root>/.reharness/commands/*.ts`. */
export async function loadProject(root: string): Promise<Project | null> {
  const commandsDir = resolve(root, ".reharness", "commands");
  if (!existsSync(commandsDir) || !statSync(commandsDir).isDirectory()) return null;

  const agents = resolve(root, ".reharness", "agents");
  const commands: Record<string, CommandDefinition> = {};

  for (const file of readdirSync(commandsDir).filter(f => /\.(ts|js)$/.test(f))) {
    const name = basename(file).replace(/\.(ts|js)$/, "");
    try {
      const mod = await import(resolve(commandsDir, file));
      if (mod?.default?.run) commands[name] = mod.default;
      else console.error(`⚠ ${file}: missing default export with run()`);
    } catch (err: any) {
      console.error(`✗ Failed to load "${name}": ${err.message}`);
    }
  }
  return { root, agents, commands };
}
