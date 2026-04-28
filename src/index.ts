/**
 * pi-fsm: Deterministic multi-agent pipeline framework.
 *
 * ```typescript
 * import { defineCommand, definePipeline } from 'pi-fsm';
 *
 * export default defineCommand({
 *   description: 'Build something',
 *   usage: '<name>',
 *   run: (args, ctx) => definePipeline({
 *     config: { name: args[0] },
 *     initial: 'plan',
 *     states: {
 *       plan:  { entry: async (c) => { await c.agent('planner', '...'); }, on: 'build' },
 *       build: { entry: async (c) => { await c.agent('coder', '...'); },   on: 'done' },
 *       done:  { type: 'final', status: 'success' },
 *     },
 *   }),
 * });
 * ```
 */

export { definePipeline, findResumableRun } from "./fsm.js";
export { runAgentProcess } from "./agent.js";
export { loadProject } from "./project.js";
export { startTui, runDirect } from "./tui-app.js";
export { formatDuration } from "./ui.js";

export type {
  PipelineDefinition,
  Pipeline,
  RunOptions,
  StateDefinition,
  ActiveState,
  FinalState,
  StateContext,
  TransitionTarget,
  GuardedTransition,
  CommandDefinition,
  CommandContext,
  Project,
} from "./types.js";

/** Helper to define a command with type checking. */
export function defineCommand(def: import("./types.js").CommandDefinition): import("./types.js").CommandDefinition {
  return def;
}
