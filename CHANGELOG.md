# Changelog

All notable changes to reharness are documented here. This project adheres to [Semantic Versioning](https://semver.org/);
while `0.x`, the runtime/compiler API may change between minor versions.

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
