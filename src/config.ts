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
/** Default backend the agent leaves run on: "pi" | "claude". Per-pipeline (def.provider) and per-run (--provider)
 *  override this. "claude" lets a Claude Code subscription drive the agents instead of paying per-token. */
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
/** Runs a freshly-bound evolve tool survives before the retention gate may trim it (the utility-problem grace). */
export const EVOLVE_GRACE = num("REHARNESS_EVOLVE_GRACE", 3);
