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
  /** Abort entry after this many ms; transitions to on.TIMEOUT (or fails if absent). */
  timeoutMs?: number;
}

/** Approval checkpoint: pause, show artifacts, await chosen event. */
export interface ApprovalState<C extends Record<string, any> = Record<string, any>> {
  type: "approval";
  prompt: string;
  artifacts?: string[];
  /** Event used to resolve the checkpoint in auto-approve mode. */
  autoEvent?: string;
  on: TransitionMap<C>;
  timeoutMs?: number;
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
  timeoutMs?: number;
  /** Optional transitions — only `TIMEOUT` event is meaningful. */
  on?: TransitionMap<C>;
}

/** Wait: suspend until an external signal (timer / file / shell exit / webhook POST). Transitions on DONE/TIMEOUT/ERROR. */
export interface WaitState<C extends Record<string, any> = Record<string, any>> {
  type: "wait";
  mode: "timer" | "file" | "shell" | "webhook";
  /** ms — for timer mode. */
  durationMs?: number;
  /** ms — across all modes that can time out. */
  timeoutMs?: number;
  /** file mode: absolute or cwd-relative file path. webhook mode: HTTP URL path. */
  path?: string;
  /** shell mode: command line. */
  command?: string;
  /** webhook mode: TCP port to listen on. */
  port?: number;
  /** file mode: poll interval in ms (default 1000). */
  pollIntervalMs?: number;
  on: TransitionMap<C>;
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
  timeoutMs?: number;
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
  timeoutMs?: number;
  /** Optional transitions — only `TIMEOUT` event is meaningful (other completions go to `join`). */
  on?: TransitionMap<C>;
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
  | WaitState<C>
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
  /** Upstream single-dir producers visible to this agent (top-level / loop-step). Runtime injects each dir. */
  inputs?: string[];
  /** Upstream parallel-branch producers visible to this agent — each injected as one dir per branch item.
   *  Both lists are derived from the graph by codegen (visibleProducers), never hand-written. */
  inputLists?: string[];
  /** Deterministic in-session validator: returns error strings (empty = ok). On failure the agent's live
   *  session is re-prompted with the errors so it self-corrects in-context. Runs the agent under RPC. */
  validate?: () => string[] | Promise<string[]>;
  /** Agent-dir-relative prompt basename to append to the system prompt (e.g. a shared syntax reference). */
  append?: string;
  /** Per-leaf harness (synthesized by codegen from the state's <harness>). Lowered to Pi flags by the
   *  runtime; all optional, absent ⇒ Pi defaults. See docs/design/per-agent-harness.md. */
  thinking?: string;
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  noContextFiles?: boolean;
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
  /** In-memory scalars (written by code/set states; read by guards/over/exit/model-expr). Runtime-provided keys:
   *  `data.iteration` = the CURRENT loop iteration's 0-based COORDINATE (valid only inside a loop step; after the
   *  loop it holds the last index, not a count). `data.iterations` = the iteration COUNT (cardinality), set after
   *  the loop completes. To report "how many iterations ran", read `data.iterations` — never `data.iteration + 1`. */
  data: Record<string, any>;
  runDir: string;
  runId: string;
  /** Name of the stage currently executing (set by the runtime). Backs `c.out`. */
  stage?: string;
  /** This stage's own output directory (per-branch when running as a parallel branch). Write outputs here. */
  out: () => string;
  /** A single upstream producer's output dir (top-level / loop-step stage). Read its files from here. */
  dir: (stage: string) => string;
  /** A parallel-branch producer's output dirs — one per branch item (globbed). Read each branch's files. */
  dirs: (stage: string) => string[];
  /** Abort signal for the current state — combines pipeline-level and state-level timeouts. */
  signal?: AbortSignal;
  /** Set only when invoked as a parallel branch: the current item from `over` expression. */
  branchInput?: any;
  /** Set only when invoked as a parallel branch: 0-based index. */
  branchIndex?: number;
  /** Set only when invoked as a parallel branch: absolute path to per-branch workspace. */
  branchDir?: string;
  /** This execution's INSTANCE VECTOR: one index per enclosing composite (parallel branch / loop iteration),
   *  outermost-first. Backs the workspace addressing (c.out/c.dir/c.dirs). `[]` at the top level. */
  instancePath?: number[];
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
