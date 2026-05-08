/**
 * reharness — Finite State Machine types.
 */

// ── FSM Core ────────────────────────────────────────────────────

/** A guarded transition: target + optional guard condition. */
export interface GuardedTransition<C extends Record<string, any> = Record<string, any>> {
  target: string;
  guard?: (ctx: StateContext<C>) => boolean;
}

/** Transition target — string shorthand, guarded, or array of guarded (first match wins). */
export type TransitionTarget<C extends Record<string, any> = Record<string, any>> =
  | string
  | GuardedTransition<C>
  | Array<GuardedTransition<C>>;

/** Transition table — maps event names to targets. */
export type TransitionMap<C extends Record<string, any> = Record<string, any>> =
  Record<string, TransitionTarget<C>>;

/** An active state: has entry action and transitions. */
export interface ActiveState<C extends Record<string, any> = Record<string, any>> {
  /** Action to run when entering this state. Returns event name or void (= 'DONE'). */
  entry: (ctx: StateContext<C>) => Promise<string | void>;
  /** Action to run when leaving this state. */
  exit?: (ctx: StateContext<C>) => Promise<void>;
  /**
   * Transitions.
   * - `string` → shorthand for `{ DONE: target }`
   * - `Record<event, target>` → full transition table
   */
  on: string | TransitionMap<C>;
}

/** A final (terminal) state. Pipeline ends here. */
export interface FinalState<C extends Record<string, any> = Record<string, any>> {
  type: "final";
  status: "success" | "error";
  /** Optional entry action (e.g. emit "BUILD COMPLETE"). */
  entry?: (ctx: StateContext<C>) => Promise<void>;
}

/** State definition — either active or final. */
export type StateDefinition<C extends Record<string, any> = Record<string, any>> =
  | ActiveState<C>
  | FinalState<C>;

// ── Pipeline Definition ─────────────────────────────────────────

/** Pipeline definition — an FSM with config. */
export interface PipelineDefinition<C extends Record<string, any> = Record<string, any>> {
  /** User-defined config (available as ctx.config). */
  config: C;
  /** Initial state name. */
  initial: string;
  /** State definitions. */
  states: Record<string, StateDefinition<C>>;
  /** Agent prompts directory. Absolute or relative to cwd. Defaults to .reharness/agents/. */
  agents?: string;
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Run logs directory. Defaults to <cwd>/logs. */
  logsDir?: string;
  /** Pi binary name. Defaults to "pi". */
  piBinary?: string;
  /** Pi model specifier, e.g. "anthropic/claude-sonnet-4-6". Passed as --model to Pi. */
  piModel?: string;
}

/** Options for pipeline.run(). */
export interface RunOptions {
  resume?: boolean;
  data?: Record<string, any>;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
  /** Override Pi model at runtime (e.g. from CLI --model flag). Takes precedence over PipelineDefinition.piModel. */
  piModel?: string;
}

/** A pipeline object returned by definePipeline. */
export interface Pipeline {
  run: (emit: (msg: string) => void, options?: RunOptions) => Promise<"success" | "error">;
  states: Record<string, StateDefinition>;
  config: Record<string, any>;
}

/** Per-agent options passed to ctx.agent() / ctx.interactive(). */
export interface AgentOpts {
  /** Override Pi model for this agent call (e.g. "anthropic/claude-haiku-4-5"). */
  model?: string;
}

// ── State Context ───────────────────────────────────────────────

/** Context available inside state entry/exit actions. */
export interface StateContext<C extends Record<string, any> = Record<string, any>> {
  /** User-defined config. */
  config: C;
  /** Emit a progress message to the log area. */
  emit: (msg: string) => void;
  /** Update the TUI status bar. */
  status: (text: string) => void;
  /** Run a Pi agent by name. Throws on failure. */
  agent: (name: string, task: string, opts?: AgentOpts) => Promise<void>;
  /** Run an interactive Pi agent session in a tmux pane. Requires tmux. */
  interactive: (name: string, task: string, opts?: AgentOpts) => Promise<void>;
  /** Run a shell command. Returns true on exit 0, false otherwise. Auto-emits ✓/✗. */
  shell: (cmd: string, label?: string) => boolean;
  /** Increment retry counter. Returns new count. */
  retry: (key: string) => number;
  /** Get current retry count (without incrementing). */
  retries: (key: string) => number;
  /** Shared data between states (persisted for resume). */
  data: Record<string, any>;
  /** Current run log directory. */
  runDir: string;
  /** Current run ID. */
  runId: string;
}

// ── Commands ────────────────────────────────────────────────────

export interface CommandContext {
  root: string;
  agents: string;
  cwd: string;
}

export interface CommandDefinition {
  description: string;
  usage?: string;
  run: (args: string[], ctx: CommandContext) => Pipeline | null;
}

export interface Project {
  root: string;
  agents: string;
  commands: Record<string, CommandDefinition>;
}
