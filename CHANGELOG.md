# Changelog

All notable changes to reharness are documented here. This project adheres to [Semantic Versioning](https://semver.org/);
while `0.x`, the runtime/compiler API may change between minor versions.

## Unreleased

### Added
- `compile --from-harness <dir>` — compile from an existing harness/implementation directory (research explores it in place).
- **Two-timer agent watchdog**: an L1 idle timer (kill on silence, reset by streaming) plus non-extendable L3 ceilings
  (`maxMs`/`maxUsd`/`maxTokens`). Env- and `--param`-configurable, default off; a trip fails loud into the verdict.
- **Accurate token accounting**: `cacheRead`/`cacheWrite` are captured (uncached input alone undercounted input ~30×);
  the run verdict reports total / output / cached tokens and the cache-discounted cost.
- `--optimize` — a cost-aware compile: a judgment-floor design objective (mechanical→code, terse structured output) and,
  when compiling from a source harness/trace, **task-first re-derivation** (the source is a reference, not a template);
  plus a static optimization-opportunity analyzer (context surface, fan-in, dead producers, over-share).
- **Output-side data-flow (render-once)**: an aggregator references its producers, never restates them — the dual of
  input need-to-know. New `c.dir`/`c.dirs` stage-reference check: a literal must name a producer stage (the workspace
  dual of config-flow), caught at compile time.
- **Opt-in prompt-cache priming for parallel fan-out** (`--param <parallel>.prime=1`): warm an agent-branch's shared
  prompt prefix once before the worker pool so the branches reuse it (input-side CSE). Semantically transparent,
  fail-soft, default off.

### Changed
- A timeout on **any** state now surfaces a warning in the run verdict, rather than being silently lost on non-`polish` states.
- Compiler prompts: a raw user/external input (`config.<arg>`) has no graph-authored schema, so its **first reader must
  be an `agent`** (never a `code` `JSON.parse` of free-form input); a missing **required** upstream producer is
  **fail-loud** (`throw` → ERROR), never defaulted to a plausible "success" value.
- Interprocedural `ctx.data` I/O extraction (follows ctx-threaded helper calls) for the definite-assignment check.

### Removed
- **Claude Code backend** (`--provider claude`). Pi is the only backend; the `Provider` seam in `runtime/providers.ts`
  remains so adding a new backend is one adapter, not a cross-cutting change.

## 0.1.0 — first public release

reharness compiles a natural-language request — or a recorded agent trace — into a **deterministic FSM pipeline**,
with model judgment only at the clearly-marked `agent` leaves. A fully-mechanical task compiles to **zero runtime
model calls**.

### Compiler
- `compile <description>` — request → human-approved PRD → FSM graph → generated TypeScript pipeline.
- `compile --from-session <path>` — distil a recorded session (any format) into a reusable pipeline.
- `amend [<command>] <request>` — fold a change into an existing pipeline's PRD and regenerate.
- `evolve [<command>]` — learn from the last run: self-heal failures, amortize repeated routines into tools, refine skills.
- One human checkpoint (the PRD), never the graph. Backends are pluggable: **Pi** (default) or **Claude Code**
  (`--provider claude`, to drive the agents on a subscription).

### Static analysis (a compiled pipeline is verified before it runs)
- Reachability + dead-end detection, definite-assignment data-flow over `ctx.data`, config-flow, guaranteed loop
  termination (every `loop` requires `max`), workspace-escape and substrate-violation checks, TypeScript compile.

### Runtime
- Deterministic hierarchical Moore-action transducer with run-to-completion; total, fail-loud transition function.
- `parallel` fork-join (real process parallelism), bounded `loop`, `switch`, `wait`, `call`, `approval`, `set`.
- Derived (never declared) inter-stage data flow; per-state `timeoutMs`; resume of an interrupted run.
- `c.shell` (boolean) and `c.exec` (full result) — both async, abortable, timeout-bounded, dry-run-aware.

### Tooling
- `graph <command>` — render the compiled FSM to Mermaid (`<command>.mmd`) or a self-contained interactive
  viewer (`--html`). Deterministic, no model call.
- `<command> --dry-run` — smoke-test routing, guards and data flow with agents/shells stubbed, for **0 tokens**.
- `--param` / `--params` per-run hyperparameter overrides.

### Reliability, security & operations
- Transient-failure retry with exponential backoff + jitter for agent calls (`REHARNESS_AGENT_RETRIES`).
- Clear "backend not found" errors instead of a raw `ENOENT`.
- Secret redaction in traces, terminal output and persisted state (URL credentials, `Authorization`, common token shapes).
- Bounded disk usage: per-command run retention (`REHARNESS_RUN_RETENTION`).

### Distribution
- The compiled `reharness/` bundle is a first-class, liftable deliverable: it declares `reharness` as a dependency,
  so `mv` it elsewhere, run `npm install`, and it runs. Run-exhaust is quarantined under a gitignored `.cache/`.

### Known limitations
See **Operating in production → Known limitations** in the README. Notably: no global wall-clock run timeout
(bound individual states); run records live next to their output target (no cross-target run browser); a lifted
bundle needs `reharness` installed at its new location; Linux/macOS are the tested platforms.
