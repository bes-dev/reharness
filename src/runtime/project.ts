import { existsSync, readdirSync, statSync } from "fs";
import { resolve, basename } from "path";
import { pathToFileURL } from "url";
import type { Project, CommandDefinition } from "./types.js";
import { layout } from "../layout.js";

/** Load all command modules from the bundle's `commands/` (`<root>/reharness/commands/*.ts`). */
export async function loadProject(root: string): Promise<Project | null> {
  const L = layout(root);
  const commandsDir = L.commands;
  if (!existsSync(commandsDir) || !statSync(commandsDir).isDirectory()) return null;

  const agents = L.agents;
  const commands: Record<string, CommandDefinition> = {};

  for (const file of readdirSync(commandsDir).filter(f => /\.(ts|js)$/.test(f))) {
    const name = basename(file).replace(/\.(ts|js)$/, "");
    try {
      // import() needs a file:// URL, not a raw absolute path — a bare path throws ERR_UNSUPPORTED_ESM_URL_SCHEME
      // on Windows (POSIX tolerates it). pathToFileURL is correct on every platform.
      const mod = await import(pathToFileURL(resolve(commandsDir, file)).href);
      if (mod?.default?.run) commands[name] = mod.default;
      else console.error(`⚠ ${file}: missing default export with run()`);
    } catch (err: any) {
      console.error(`✗ Failed to load "${name}": ${err.message}`);
    }
  }
  return { root, agents, commands };
}
