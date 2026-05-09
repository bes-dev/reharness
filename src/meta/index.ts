/**
 * reharness meta: FSM generators (generate, evolve, init).
 */

import type { CommandDefinition } from "../core/types.js";
import { makeGenerateCommand } from "./commands/generate.js";
import { makeEvolveCommand } from "./commands/evolve.js";

/** Get meta commands, using metaDir to locate agent prompts and references. */
export function getMetaCommands(metaDir: string): Record<string, CommandDefinition> {
  return {
    generate: makeGenerateCommand(metaDir),
    evolve: makeEvolveCommand(metaDir),
  };
}
