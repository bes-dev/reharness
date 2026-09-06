// reharness's own hyperparameters — one place, each overridable via a REHARNESS_* env var.
//
// Scope: these are the compiler's and runtime's OWN tuning knobs (timeouts, fan-out width, correction budgets).
// They are NOT a compiled pipeline's structural parameters — a pipeline's loop `max`, parallel `concurrency`, and
// state `timeoutMs` are tuned per-run via `pipeline.run({ overrides })` / the CLI `--param state.knob=value`
// (see the runtime). And format/truncation literals (a label length, how many stderr lines to echo, a run-id
// length) are deliberately NOT knobs — they have one correct value and are not tuning axes; keeping them inline
// avoids config-bloat.

const num = (envVar: string, def: number): number => {
  const v = Number(process.env[envVar]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
/** Like `num`, but 0 is a meaningful value (disable) — only a negative/NaN falls back to the default. */
const num0 = (envVar: string, def: number): number => {
  const v = Number(process.env[envVar]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const str = (envVar: string, def: string): string => process.env[envVar] || def;

// ── runtime ────────────────────────────────────────────────────────────────
/** Default backend the agent leaves run on (registered: "pi" | "opencode"). Per-pipeline
 *  (def.provider) and per-run (--provider) override this; a new backend is added as one Provider in
 *  runtime/providers.ts. */
export const PROVIDER = str("REHARNESS_PROVIDER", "pi");
/** Hard cap on a single `c.shell(...)` command — a hung shell must not hang the run. */
export const SHELL_TIMEOUT_MS = num("REHARNESS_SHELL_TIMEOUT_MS", 120_000);
/** Default poll interval for a `wait` state in timer/file/shell mode (when it declares no `pollIntervalMs`). */
export const POLL_MS = num("REHARNESS_POLL_MS", 1_000);
/** Transient-failure retry budget for ONE agent leaf (rate-limit / 5xx / dropped connection). 0 disables retries.
 *  The leaf still fails loud once the budget is exhausted — this only papers over momentary backend hiccups. */
export const AGENT_RETRIES = num0("REHARNESS_AGENT_RETRIES", 2);
/** Base backoff (ms) between agent retries — exponential (×2^attempt) with ±50% jitter. */
export const AGENT_BACKOFF_MS = num("REHARNESS_AGENT_BACKOFF_MS", 1_000);

// ── per-agent watchdog (the two-timer model for a poorly-predictable work horizon) ────────────────────────────
// A fixed wall-clock timeout kills a slow-but-working agent and a hung one alike. The watchdog separates LIVENESS
// (is it still emitting events?) from a hard CEILING (it may not run forever): the idle timer waits on a working
// leaf and kills only a silent one; the ceilings (wall-clock / cost / tokens) are non-extendable and bound a
// runaway "playing solitaire" agent — limited liability that can't be escaped. All default 0 = DISABLED (opt-in,
// zero behaviour change); set globally here or per-leaf via `--param <state>.{idleMs|maxMs|maxUsd|maxTokens}`.
/** L1 — idle/heartbeat: kill an agent leaf that emits NO backend event for this long (a hung process). The timer
 *  resets on every stream event, so a slow-but-PRODUCING agent is never killed — only a silent one. 0 = disabled. */
export const AGENT_IDLE_MS = num0("REHARNESS_AGENT_IDLE_MS", 0);
/** L3 — absolute wall-clock ceiling for one agent leaf (across retries; non-extendable runaway backstop). 0 = off. */
export const AGENT_MAX_MS = num0("REHARNESS_AGENT_MAX_MS", 0);
/** L3 — hard cost ceiling (USD) for one agent leaf, summed across retries. 0 = disabled. */
export const AGENT_MAX_USD = num0("REHARNESS_AGENT_MAX_USD", 0);
/** L3 — hard token ceiling (in+out) for one agent leaf, summed across retries. 0 = disabled. */
export const AGENT_MAX_TOKENS = num0("REHARNESS_AGENT_MAX_TOKENS", 0);
/** How many past runs to keep in a command's logs dir; older `run-*` dirs are pruned at run start. 0 = keep all. */
export const RUN_RETENTION = num0("REHARNESS_RUN_RETENTION", 20);

// ── compiler ───────────────────────────────────────────────────────────────
/** Max chars of a session fed to one distil pass before it is condensed (map–reduce) first. */
export const SESSION_CHUNK_CHARS = num("REHARNESS_SESSION_CHUNK_CHARS", 80_000);
/** Cheap model for the surgical fix_verify patch (a mechanical TS edit, not a judgment). */
export const LIGHT_MODEL = str("REHARNESS_LIGHT_MODEL", "anthropic/claude-haiku-4-5");
/** Fan-out width of the compiler's OWN internal parallel stages (fill / enhance / evolve / condense). */
export const COMPILER_CONCURRENCY = num("REHARNESS_COMPILER_CONCURRENCY", 4);
/** Budget of a bounded correction loop (fix_verify / polish→redesign / heal / replan) before it gives up. */
export const CORRECTION_RETRIES = num("REHARNESS_CORRECTION_RETRIES", 2);
/** Polish watchdog (a deep harness makes the one-pass correction long): L1 idle — kill polish only after this much
 *  SILENCE (a working polish streams, so it runs to completion); replaces the old blind total wall-clock. */
export const POLISH_IDLE_MS = num("REHARNESS_POLISH_IDLE_MS", 240_000);
/** Polish watchdog L3 — the non-extendable absolute ceiling, so a runaway polish that games liveness still dies. */
export const POLISH_MAX_MS = num("REHARNESS_POLISH_MAX_MS", 1_800_000);
/** Runs a freshly-bound evolve tool survives before the retention gate may trim it (the utility-problem grace). */
export const EVOLVE_GRACE = num("REHARNESS_EVOLVE_GRACE", 3);
