/**
 * reharness core: Deterministic multi-agent pipeline framework.
 */

export { definePipeline, findResumableRun } from "./fsm.js";
export { runAgentProcess, runInteractiveProcess } from "./agent.js";
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
  AgentOpts,
} from "./types.js";

export type { AgentRunConfig, AgentRunResult } from "./agent.js";

/** Helper to define a command with type checking. */
export function defineCommand(def: import("./types.js").CommandDefinition): import("./types.js").CommandDefinition {
  return def;
}
