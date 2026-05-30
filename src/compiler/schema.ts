/** Skeleton ids reserved by reharness itself. */
export const RESERVED_IDS = new Set(["generate", "evolve"]);

export interface GuardedTransition {
  target: string;
  /** Either `retries:KEY<N` (retry counter) OR a `expr:<safe-subset-JS>` expression. Empty → unconditional. */
  guard?: string;
}

export interface DataAssignment {
  key: string;
  /** Expression in the same safe-subset language as guards. */
  value: string;
}

export type WaitMode = "timer" | "file" | "shell" | "webhook";

export interface SkeletonState {
  type: "agent" | "interactive" | "code" | "approval" | "switch" | "set" | "parallel" | "loop" | "call" | "wait" | "final";
  status?: "success" | "error";
  on?: Record<string, string | GuardedTransition[]>;
  /** Approval only: prompt text shown at the checkpoint. */
  prompt?: string;
  /** Approval / interactive only: file paths to display / edit. */
  artifacts?: string[];
  /** Approval only: event used by auto-approve mode. */
  autoEvent?: string;
  /** Switch only: ordered branches, first guard true wins. */
  branches?: GuardedTransition[];
  /** Set only: data writes performed on entry, before transitioning. */
  dataAssignments?: DataAssignment[];
  /** Parallel only: expression returning the array to fan out over. */
  overExpr?: string;
  /** Parallel only: state name to invoke per item. */
  parallelBranch?: string;
  /** Parallel / loop: state to transition to after the construct completes. */
  join?: string;
  /** Parallel only: max concurrent branches (optional cap). */
  concurrency?: number;
  /** Loop only: ordered list of state names to run per iteration. */
  loopSteps?: string[];
  /** Loop only: hard iteration cap (safety). REQUIRED on every loop — guarantees termination (lint enforces
   *  it). `exitExpr` is an optional early-out, not a substitute for the bound. */
  maxIterations?: number;
  /** Loop only: expression evaluated after each iteration; truthy → exit to join. */
  exitExpr?: string;
  /** Call only: skeleton id to invoke as a sub-pipeline. */
  callSkeleton?: string;
  /** Call only: expression returning string[] of CLI args for the sub-pipeline. */
  callArgsExpr?: string;
  /** Wait only. */
  waitMode?: WaitMode;
  /** Wait timer/file/shell/webhook: duration (e.g. "30s") or absolute timeout. */
  waitDuration?: string;
  waitTimeout?: string;
  /** Wait file: path to watch. Wait webhook: HTTP URL path (e.g. "/cb"). */
  waitPath?: string;
  /** Wait shell: command line. */
  waitCommand?: string;
  /** Wait webhook: TCP port. */
  waitPort?: number;
  /** Wait file: poll interval (default "1s"). */
  waitPollInterval?: string;
  /** Universal: abort state execution after this duration. Triggers `TIMEOUT` event (or fail if no transition). */
  timeout?: string;
  /** Agent only: expression returning model id (string) for `opts.model`. Falsy/undefined → use pipeline default. */
  modelExpr?: string;
  /** Behavioural contract: what this node must guarantee. Written by the `design` pass; consumed by fill_prompts. */
  contract?: string;
  /** data.* / config.* keys this node REQUIRES present on entry (code/set states). Extracted from generated
   *  code for code states; the data-flow (use-before-def) analyzer uses it. */
  reads?: string[];
  /** data.* keys this node DEFINITELY sets (code/set states). Extracted from generated code for code states. */
  writes?: string[];
}

/** One CLI input the pipeline reads as `config.<name>`. The EXTERNAL interface (user → pipeline) — it cannot
 *  be derived from the graph (no producer node, no edge), so it is declared; codegen generates the parser and
 *  the static config-flow check verifies every `config.X` the pipeline reads is declared here. */
export interface InputDecl {
  /** Field on `config`. Read in code as `c.config.<name>`, in expressions as `config.<name>`. */
  name: string;
  /** Parse from a positional argument (in declaration order) instead of a flag. */
  positional?: boolean;
  /** CLI flag override; default is `--<name-in-kebab>`. Ignored when `positional`. */
  flag?: string;
  /** Coercion of the raw string: list = comma-split, bool = presence. Default `string`. */
  type?: "string" | "number" | "list" | "bool";
  /** Default value (string literal, coerced by `type`) when the arg is absent. */
  default?: string;
  /** If set and absent with no default, the command reports a usage error (returns null). */
  required?: boolean;
}

export interface Skeleton {
  id: string;
  description: string;
  usage: string;
  initial: string;
  formatVersion?: string;
  /** Declared CLI inputs (the external interface). Empty/absent → only `config.{target,input}` are provided. */
  inputs?: InputDecl[];
  states: Record<string, SkeletonState>;
}
