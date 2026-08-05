# reharness — LLM Reference (runtime API usage)

You are working with reharness, a finite state machine framework for multi-agent pipelines. It orchestrates Pi coding agents as states in an FSM with typed transitions, guards, and events.

This file is the **how-to-write-it API reference**. For the *why* — the formal execution model, the static analyzer, and the data-flow model — see **`.claude/theory/`** (runtime.md, analysis.md, pipeline.md). The runtime is a deterministic hierarchical Moore-action transducer with run-to-completion: each state runs to completion and emits one event; transitions are total and fail loud; composite states (parallel/loop/call) are run-to-completion sub-computations.

## Core Concepts

**Pipeline** — a finite state machine. States execute entry actions and emit events. Events trigger transitions to the next state. Guards conditionally select transitions. Final states end the pipeline.

**State** — has an `entry` action (async function) and transitions (`on`). Entry returns an event name (string) or void (= `DONE` event).

**Transition** — maps event to target state. Can have guards (conditions). Array of targets = first matching guard wins.

**Agent** — a Pi coding agent subprocess. Gets a markdown prompt (`.md`) and a task string. Runs autonomously with tools (read/write/edit/bash/grep/find).

**Command** — user-facing entry point in `reharness/commands/`. Parses arguments, constructs a pipeline, returns it.

## Project Structure

The `reharness/` bundle is a first-class, liftable deliverable; regenerable run-exhaust lives under a hidden `.cache/`.

```
project/
└── reharness/                # the deliverable (version it / ship it / `mv` it — self-contained)
    ├── skeletons/     # <id>.xml — source of truth for generated pipelines
    ├── prds/          # <cmdId>.md — approved intent archive
    ├── commands/      # Each file = one slash command, auto-discovered (codegen output for generated ones)
    ├── skills/        # <topic>.md — domain-skills from research (grounded knowledge, attached to leaves)
    ├── agents/        # Per command: <command>/<name>/SYSTEM.md (+ optional harness.json)
    ├── lib/           # Code-state implementations (<id>-states.ts)
    └── .cache/        # run-exhaust (gitignored): runs/ (run-*/{state.json, work/, trace/}), evolve/ (ledger), scratch/
```

## Writing a Pipeline

```typescript
import { definePipeline } from 'reharness';

definePipeline({
  config: { slug, idea },
  initial: 'plan',           // Start state (must exist)
  agents: ctx.agents,        // Optional, defaults to reharness/agents/

  states: {
    // Linear state — do work, move on
    plan: {
      entry: async (ctx) => { await ctx.agent('planner', 'Plan the project'); },
      on: 'code',  // shorthand: DONE event → 'code'
    },

    // Branching state — entry returns event name
    verify: {
      entry: async (ctx) => {
        const ok = await ctx.shell('npx tsc --noEmit', 'tsc');
        return ok ? 'PASS' : 'FAIL';  // event name
      },
      on: {
        PASS: 'done',
        FAIL: [
          { target: 'fix', guard: (ctx) => ctx.retries('v') < 3 },
          { target: 'error' },  // no guard = fallback
        ],
      },
    },

    // Fix + retry loop
    fix: {
      entry: async (ctx) => {
        ctx.retry('v');  // increment counter
        await ctx.agent('fixer', 'Fix the errors');
      },
      on: 'verify',  // back to verify
    },

    // Final states — pipeline ends here
    done:  { type: 'final', status: 'success', entry: async (ctx) => { ctx.emit('Done!'); } },
    error: { type: 'final', status: 'error' },
  },
});
```

### State Rules

1. `initial` state must exist in `states`.
2. Every transition target must reference an existing state. Validated at definition time — typos throw immediately.
3. At least one `{ type: 'final' }` state required.
4. Entry returns `string` → that string is the event. Entry returns `void` → event is `'DONE'`.
5. `on: 'target'` is shorthand for `on: { DONE: 'target' }`.
6. Guard arrays: evaluated in order, first with `guard === undefined` or `guard() === true` wins.

### Transition Formats

```typescript
// Simple: always go to target
on: 'nextState'

// Event map: different events → different targets
on: {
  PASS: 'success',
  FAIL: 'error',
}

// Guarded: first matching guard wins
on: {
  FAIL: [
    { target: 'fix', guard: (ctx) => ctx.retries('k') < 3 },
    { target: 'error' },  // fallback
  ],
}

// Single guarded transition
on: {
  DONE: { target: 'next', guard: (ctx) => someCondition },
}
```

## Composite states (run-to-completion sub-machines)

- **`parallel`** — fan out over an array, run `branch` once per item, join after all settle. `{ type: 'parallel', over: (c) => c.data.items, branch: 'work', join: 'aggregate', concurrency?: N }`. After it, `c.data.branches = [{ index, input, dir, ok, error? }]`. Agent branches run as real concurrent OS processes; **each branch gets its OWN copy of `ctx.data`** (forked at the split), so concurrent branches never race — but a branch's `ctx.data` writes are branch-local and **don't propagate to the parent**. Branches communicate via their output dirs; the join reads `data.branches`.
- **`loop`** — bounded iteration. `{ type: 'loop', steps: ['actor','critic'], join: 'synth', max: 5, exit?: (c) => c.data.agreed }`. **`max` is required** — it is the termination guarantee (a hard cap); `exit` is an optional early-out, never a substitute (an `exit`-only loop can diverge on a never-true predicate). `c.data.iteration` is the 0-based counter.
- **`call`** — invoke another pipeline as a sub-machine. **`wait`** — suspend until an external signal (timer/file/shell/webhook). **`switch`** — declarative routing, no entry (first true guard wins).

A branch/step state's own `<on>` is ignored — control returns to the parent's `join`.

**Per-run overrides.** The compiled values of a loop's `max`, a parallel's `concurrency`, and any state's `timeoutMs`
are tunable per run without recompiling: `reharness <command> --param state.knob=value` (or a `--params <file.json>`
profile). They are applied at the runtime layer (`RunOptions.overrides`, keyed `state.knob`) and validated fail-loud —
a `max` override stays a finite integer ≥1, so the termination guarantee holds. The compiler's *own* knobs (fan-out
width, correction-retry budget, shell timeout, …) live in `src/config.ts`, each overridable via a `REHARNESS_*` env var.

**Backend (provider).** Agent leaves run on a registered backend: `pi` (default), `opencode`, or `hermes`. Select via
`--provider`, `def.provider`, or `REHARNESS_PROVIDER`. The FSM is provider-agnostic; the backend is one adapter in
`src/runtime/providers.ts` (argv lowering of the three axes + event-stream normalization + RPC turn-framing), so a new
backend is one Provider, not a cross-cutting change. `--model` / `def.model` choose the model within the backend
(`def.piModel`/`def.piBinary` remain accepted as legacy aliases; resolution is `model ?? piModel`, `binary ?? piBinary`
— the neutral name wins when both are set). Mode support: pi/opencode support all three run modes (oneshot, RPC for
`validate` leaves, interactive); **hermes is oneshot/interactive only** — a `validate` leaf assigned to it fails loud
pre-spawn with a redirect. Hermes's headless mode emits no live event stream (its spend is read post-exit from its
`--usage-file`, never estimated) and has no extension axis (a harness.json `extensions` entry degrades with a loud
warning, never silently dropped).

## State Context API

### `ctx.agent(name, task, opts?)`

Run an LLM agent. `name` resolves to `<agents>/<name>/SYSTEM.md`, falling back to a flat `<agents>/<name>.md`. For a generated command, `<agents>` is its per-command dir (the command bakes `agents: resolve(ctx.agents, '<cmdId>')` → `agents/<cmdId>/<name>/SYSTEM.md`); the flat fallback is for hand-written / meta-pipeline agents. Returns void — agent output is files on disk.

```typescript
await ctx.agent('coder', `Implement apps/${slug}`);
await ctx.agent('research', task, { model: 'anthropic/claude-opus-4-6' });  // per-agent model
```

- Throws if prompt file doesn't exist or agent exits non-zero.
- `opts`: `{ model }` overrides the pipeline-level model; `{ inputs: ['stage', …] }` / `{ inputLists: ['branchStage', …] }` expose those upstream producers' dirs to the agent (the runtime resolves + injects them — generated pipelines fill these from the graph); `{ validate }` runs the agent under RPC and re-prompts it with the returned errors until clean; `{ append }` appends a SHARED reference at the agents-dir root (`<agents>/<append>.md`, e.g. `_fsm-syntax` — not per-agent); `{ skills }` / `{ extensions }` are the per-leaf harness (domain-skill paths + Pi extensions, merged with the leaf's `harness.json` — normally synthesized by the `enhance` layer, rarely hand-written).

### `ctx.interactive(name, task, opts?)`

Run an interactive LLM session with stdio attached to the user's terminal — a free-chat session. The pipeline blocks until the user exits Pi (`Ctrl+D` / `/quit`).

```typescript
await ctx.interactive('reviewer', 'Review the outline and suggest changes');
```

### Workspace: `c.out()` / `c.dir(stage)` / `c.dirs(stage)`

How stages pass **files**. Every stage has its own output directory; the runtime owns all paths — never build one by hand.

- **`c.out()`** — this stage's own output directory. Write your outputs here.
- **`c.dir(stage)`** — a single upstream producer's output dir (top-level / loop-step stage). Read its files.
- **`c.dirs(stage)`** — a parallel-branch producer's output dirs, one per branch item (read each branch's files).

These are **entry-only** — available inside a state's `entry` (and branch/step) action. **Guards and `exit` actions** have no bound stage and read only the scalar bus (`ctx.data`/`config`/`retries`); calling a workspace accessor there fails loud. Routing is a scalar decision — to branch on an agent's output, add a `code` state that reads its dir and sets `ctx.data` (the bridge, below).

```typescript
// a code state reading an upstream agent's findings and an aggregate of reviewer branches
const diff = readFileSync(join(c.dir('ingest'), 'diff.txt'), 'utf-8');
const all  = c.dirs('reviewer').map(d => JSON.parse(readFileSync(join(d, 'findings.json'), 'utf-8')));
writeFileSync(join(c.out(), 'merged.json'), JSON.stringify(all));
```

Agent states are *told* their output dir (and any upstream dirs) in the task string — they read/write files there, never `ctx.data`. For generated pipelines the visible producers are derived from the graph (see `.claude/theory/analysis.md`); you don't declare them.

### `ctx.shell(cmd, label?)`

**Async** — always `await ctx.shell(...)`. Runs the command in a child process and returns `true` (exit 0) or `false`; emits `✓/✗` automatically (last 5 lines of stderr on failure). Because it does not block the event loop, a per-state (or enclosing composite) `timeoutMs` and a run-level `AbortSignal` **interrupt it mid-command**: the child is killed and the state routes `TIMEOUT` / the run aborts. A hard backstop of `REHARNESS_SHELL_TIMEOUT_MS` (default 2 min) kills any command that outlives it. An un-awaited `ctx.shell(...)` is a bug (a truthy Promise) and is rejected by `verify`.

### `ctx.exec(cmd, args?, opts?)`

**Async** — `const r = await ctx.exec('npx', ['tsc', '--noEmit'], { timeoutMs })`. The output-returning sibling of `shell`: argv form (no shell), returns `{ ok, status, stdout, stderr }`. Use it whenever a code state needs a command's **stdout / exit code** (a build, a version probe, a CLI that prints JSON) — `shell` only tells you pass/fail. Same guarantees as `shell` (abortable, timeout-bounded — `opts.timeoutMs` or `REHARNESS_SHELL_TIMEOUT_MS`; `opts.cwd` / `opts.input` optional), **plus it is stubbed under `--dry-run`** (returns a clean success with empty output, no spawn). **Prefer `ctx.exec` over importing `child_process`** — a raw synchronous `spawnSync`/`execSync` blocks the event loop (Ctrl+C can't interrupt it) and still runs for real during a dry-run smoke test.

### `ctx.warn(message)`

Record a **degradation** — the stage succeeded but swallowed a best-effort failure (e.g. an optional output it couldn't produce). Emits the message AND persists it into the run verdict (`warnings`), so a successful-but-degraded run is visible to `evolve` (which otherwise only repairs runs that hit the error terminal). Use it instead of silently dropping a non-fatal failure.

### `ctx.emit(message)` / `ctx.status(text)`

- `emit` — log message in TUI log area
- `status` — update TUI bottom status bar (model name, progress, etc.)

**Reserved emit pattern**: `── stateName ──` — used internally for state transitions. Do not emit manually.

### `ctx.retry(key)` / `ctx.retries(key)`

Counter management for retry loops. `retry()` increments and returns new count. `retries()` reads without incrementing.

### `ctx.data`

Shared in-memory **scalar** state, read by guards / `over` / `exit` / `model-expr`. Persisted for resume. Written by **code-state `entry` actions only** — **agents run in a separate process and cannot touch `ctx.data`** (they move data through workspace files). Inside a `parallel`, each branch has its OWN `ctx.data` copy: writes are branch-local and don't propagate to the parent, so branches must communicate through their output dirs (the join reads `data.branches`). To use an agent's result in a guard, add a small `code` state that reads the agent's output dir and sets a `ctx.data` value (the bridge).

### `ctx.config`

Read-only pipeline config object.

## Writing Commands

```typescript
// reharness/commands/build.ts
import { defineCommand, definePipeline } from 'reharness';

export default defineCommand({
  description: 'Build a new app',
  usage: '<slug> <idea...>',
  run: (args, ctx) => {
    const slug = args[0];
    if (!slug) return null;  // null = validation error
    return definePipeline({ ... });
  },
});
```

`ctx` provides: `ctx.root` (project root), `ctx.agents` (reharness/agents/ path), `ctx.cwd`.

## Writing Agent Prompts

Each agent is a directory `reharness/agents/<command>/<name>/` (per-command namespace, private by default) with a `SYSTEM.md` master-prompt (+ optional `harness.json`). System prompt for autonomous Pi agent.

Guidelines:
- Keep focused — one agent, one job
- Include explicit constraints (what NOT to do)
- Reference file paths relative to pipeline's `cwd`
- Include verification commands ("Run npx tsc --noEmit after changes")
- Agent has tools: read, write, edit, bash, grep, find, ls
- Agent has no `ctx.data` access; it reads/writes **files** only. The runtime injects, in the task string, its own output directory and the output directories of its visible upstream producers (with a file listing) — read inputs from those, write outputs to the given output dir, never invent paths.

## Common Patterns

### Verify-Fix Loop

```typescript
verify: {
  entry: async (ctx) => {
    if (!await ctx.shell('npx tsc --noEmit', 'tsc')) return 'FAIL';
    if (!await ctx.shell('npx jest', 'test')) return 'FAIL';
    // void return = DONE event
  },
  on: {
    DONE: 'complete',
    FAIL: [
      { target: 'fix', guard: (ctx) => ctx.retries('v') < 3 },
      { target: 'error' },
    ],
  },
},
fix: {
  entry: async (ctx) => {
    ctx.retry('v');
    await ctx.agent('fix', 'Fix the errors');
  },
  on: 'verify',
},
```

### Conditional Branching

```typescript
check: {
  entry: async (ctx) => {
    if (existsSync('package.json')) return 'EXISTS';
    return 'MISSING';
  },
  on: {
    EXISTS: 'update',
    MISSING: 'scaffold',
  },
},
```

### Passing Data Between States

Agents return `void` — they pass data as **files in their output dir**, not return values. A downstream stage reads the upstream dir; a guard reads it via a `code` bridge into `ctx.data`.

```typescript
analyze: {
  entry: async (ctx) => { await ctx.agent('analyzer', 'Analyze the codebase; write issues.json to your output dir'); },
  on: 'gate',
},
gate: {  // code bridge: file → ctx.data scalar, so the guard can branch on it
  entry: async (c) => {
    const issues = JSON.parse(readFileSync(join(c.dir('analyze'), 'issues.json'), 'utf-8'));
    c.data.hasIssues = issues.length > 0;
    return c.data.hasIssues ? 'FIX' : 'DONE';
  },
  on: { FIX: 'fix', DONE: 'done' },
},
fix: {
  entry: async (ctx) => { await ctx.agent('fixer', 'Fix the issues from the analyze stage (read its output dir)'); },
  on: 'verify',
},
```

## Resume

Any command supports `--resume`. Pipeline saves state before each state transition. Resume loads last saved state and continues.

## Error Handling

| Scenario | What Happens |
|----------|-------------|
| Agent prompt not found | Throws: `Agent prompt not found: /path.md` |
| Agent exits non-zero | Throws: `Agent "name" failed (exit N)` |
| Shell command fails | Returns `false`, emits `✗` + last 5 stderr lines |
| Unknown event (no transition) | Emits `✗ no transition for event "X"`, returns error |
| All guards fail | Emits `✗ all guards failed`, returns error |
| State name typo | **Caught at definition time** — `definePipeline()` throws |
| Entry throws exception | Emits `✗ state failed: message`, saves state, returns error |
| Abort (Esc/Ctrl+C) | Kills agent subprocess, saves state for resume |

## Pitfalls

1. **Retry key mismatch**: `retries('verify')` in guard and `retry('verfiy')` in fix — typo silently breaks retry counting.
2. **Emitting `── name ──`**: Reserved pattern for state transitions. Corrupts TUI display.
3. **Mutating ctx.config**: Config is shared by reference. Treat as read-only.
4. **Agent task too vague**: Agents can't ask for clarification. Be specific — list files, constraints, commands.
5. **Non-serializable ctx.data**: Functions or circular refs in `data` are silently dropped on save.
6. **Reserved skeleton ids**: `generate` and `evolve` are reserved by the compiler (`RESERVED_IDS`) — a compiled command may not use them (the compiler lints it).
