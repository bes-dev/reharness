/** FSM types for reharness pipelines. */

export interface GuardedTransition<C extends Record<string, any> = Record<string, any>> {
  target: string;
  guard?: (ctx: StateContext<C>) => boolean;
}

export type TransitionTarget<C extends Record<string, any> = Record<string, any>> =
  | string
  | GuardedTransition<C>
  | Array<GuardedTransition<C>>;

export type TransitionMap<C extends Record<string, any> = Record<string, any>> =
  Record<string, TransitionTarget<C>>;

/** Active state: runs an entry action, transitions by returned event. */
export interface ActiveState<C extends Record<string, any> = Record<string, any>> {
  entry: (ctx: StateContext<C>) => Promise<string | void>;
  exit?: (ctx: StateContext<C>) => Promise<void>;
  /** `string` → shorthand for `{ DONE: target }`. */
  on: string | TransitionMap<C>;
}

/** Approval checkpoint: pause, show artifacts, await chosen event. */
export interface ApprovalState<C extends Record<string, any> = Record<string, any>> {
  type: "approval";
  prompt: string;
  artifacts?: string[];
  /** Event used to resolve the checkpoint in auto-approve mode. */
  autoEvent?: string;
  on: TransitionMap<C>;
}

/** Switch: declarative branching — no entry, runtime picks first branch whose guard is truthy. */
export interface SwitchState<C extends Record<string, any> = Record<string, any>> {
  type: "switch";
  branches: GuardedTransition<C>[];
}

/** Loop: run an ordered list of step states per iteration; exit when `exit` truthy or `max` reached. */
export interface LoopState<C extends Record<string, any> = Record<string, any>> {
  type: "loop";
  /** State names to run in sequence each iteration. */
  steps: string[];
  /** State to transition to once the loop terminates. */
  join: string;
  /** Hard cap (safety). At least one of max / exit required. */
  max?: number;
  /** Predicate evaluated after each iteration; truthy → exit to join. */
  exit?: (ctx: StateContext<C>) => boolean;
}

/** Call: invoke another skeleton's command as a sub-pipeline. Transitions by sub-pipeline status. */
export interface CallState<C extends Record<string, any> = Record<string, any>> {
  type: "call";
  /** Target skeleton id (for diagnostics/log prefix). */
  skeleton: string;
  /** Compute CLI args passed to the sub-command. */
  argsFn: (ctx: StateContext<C>) => string[];
  /** Factory that instantiates the sub-pipeline. Closure captures sub-command + parent CommandContext at codegen-time. */
  callFactory: (args: string[]) => Pipeline;
  /** Transitions keyed by sub-pipeline status (`success`, `error`). */
  on: TransitionMap<C>;
}

/** Parallel: fan out over an array, run `branch` state per item, join after all settle. */
export interface ParallelState<C extends Record<string, any> = Record<string, any>> {
  type: "parallel";
  /** Returns the array of items to fan out over (typically `config.x` or `data.x`). */
  over: (ctx: StateContext<C>) => any[];
  /** State name to invoke per item. */
  branch: string;
  /** State to transition to once all branches have settled. */
  join: string;
  /** Optional max concurrent branches (defaults to no cap). */
  concurrency?: number;
}

/** Per-branch result captured by a parallel state, available as `ctx.data.branches` in the join state. */
export interface BranchResult {
  index: number;
  input: any;
  dir: string;
  ok: boolean;
  error?: string;
}

/** Terminal state. */
export interface FinalState<C extends Record<string, any> = Record<string, any>> {
  type: "final";
  status: "success" | "error";
  entry?: (ctx: StateContext<C>) => Promise<void>;
}

export type StateDefinition<C extends Record<string, any> = Record<string, any>> =
  | ActiveState<C>
  | ApprovalState<C>
  | SwitchState<C>
  | ParallelState<C>
  | LoopState<C>
  | CallState<C>
  | FinalState<C>;

export interface PipelineDefinition<C extends Record<string, any> = Record<string, any>> {
  config: C;
  initial: string;
  states: Record<string, StateDefinition<C>>;
  /** Agent prompts directory (absolute or relative to cwd). Defaults to `.reharness/agents/`. */
  agents?: string;
  cwd?: string;
  logsDir?: string;
  piBinary?: string;
  piModel?: string;
}

export interface ApprovalCheckpoint {
  state: string;
  prompt: string;
  events: string[];
  autoEvent?: string;
  artifacts: Array<{ path: string; content: string }>;
  round: number;
  priorFeedback: string[];
}

export interface ApprovalResolution {
  event: string;
  feedback?: string;
}

export type ApprovalHandler = (cp: ApprovalCheckpoint) => Promise<ApprovalResolution>;

export interface RunOptions {
  resume?: boolean;
  data?: Record<string, any>;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
  piModel?: string;
  approvalHandler?: ApprovalHandler;
  /** Auto-resolve approval states via their auto-event. */
  autoApprove?: boolean;
}

export interface Pipeline {
  run: (emit: (msg: string) => void, options?: RunOptions) => Promise<"success" | "error">;
  states: Record<string, StateDefinition>;
  config: Record<string, any>;
}

export interface AgentOpts {
  model?: string;
}

export interface InteractiveOpts extends AgentOpts {
  /** Files the agent is contractually allowed to edit. Runtime asserts existence pre and post. */
  artifacts?: string[];
}

export interface StateContext<C extends Record<string, any> = Record<string, any>> {
  config: C;
  emit: (msg: string) => void;
  status: (text: string) => void;
  agent: (name: string, task: string, opts?: AgentOpts) => Promise<void>;
  /** Run an agent with stdio attached to the user terminal — free-chat session. Returns when user exits. */
  interactive: (name: string, task: string, opts?: InteractiveOpts) => Promise<void>;
  shell: (cmd: string, label?: string) => boolean;
  retry: (key: string) => number;
  retries: (key: string) => number;
  data: Record<string, any>;
  runDir: string;
  runId: string;
  /** Set only when invoked as a parallel branch: the current item from `over` expression. */
  branchInput?: any;
  /** Set only when invoked as a parallel branch: 0-based index. */
  branchIndex?: number;
  /** Set only when invoked as a parallel branch: absolute path to per-branch workspace. */
  branchDir?: string;
}

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
