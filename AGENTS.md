# reharness — LLM Reference (runtime API usage)

You are working with reharness, a finite state machine framework for multi-agent pipelines. It orchestrates Pi coding agents as states in an FSM with typed transitions, guards, and events.

This file is the **how-to-write-it API reference**. For the *why* — the formal execution model, the static analyzer, and the data-flow model — see **`.claude/theory/`** (runtime.md, analysis.md, pipeline.md). The runtime is a deterministic hierarchical Moore-action transducer with run-to-completion: each state runs to completion and emits one event; transitions are total and fail loud; composite states (parallel/loop/call) are run-to-completion sub-computations.

## Core Concepts

**Pipeline** — a finite state machine. States execute entry actions and emit events. Events trigger transitions to the next state. Guards conditionally select transitions. Final states end the pipeline.

**State** — has an `entry` action (async function) and transitions (`on`). Entry returns an event name (string) or void (= `DONE` event).

**Transition** — maps event to target state. Can have guards (conditions). Array of targets = first matching guard wins.

**Agent** — a Pi coding agent subprocess. Gets a markdown prompt (`.md`) and a task string. Runs autonomously with tools (read/write/edit/bash/grep/find).

**Command** — user-facing entry point in `.reharness/commands/`. Parses arguments, constructs a pipeline, returns it.

## Project Structure

```
project/
└── .reharness/
    ├── skeletons/     # <id>.xml — source of truth for generated pipelines
    ├── commands/      # Each file = one slash command, auto-discovered (codegen output for generated ones)
    ├── agents/        # Agent prompt files (<name>.md)
    ├── lib/           # Code-state implementations (<id>-states.ts)
    └── logs/          # Per-run logs + the per-stage workspace (run-*/work/<stage>[/<index>])
```

## Writing a Pipeline

```typescript
import { definePipeline } from 'reharness';

definePipeline({
  config: { slug, idea },
  initial: 'plan',           // Start state (must exist)
  agents: ctx.agents,        // Optional, defaults to .reharness/agents/

  states: {
    // Linear state — do work, move on
    plan: {
      entry: async (ctx) => { await ctx.agent('planner', 'Plan the project'); },
      on: 'code',  // shorthand: DONE event → 'code'
    },

    // Branching state — entry returns event name
    verify: {
      entry: async (ctx) => {
        const ok = ctx.shell('npx tsc --noEmit', 'tsc');
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

- **`parallel`** — fan out over an array, run `branch` once per item, join after all settle. `{ type: 'parallel', over: (c) => c.data.items, branch: 'work', join: 'aggregate', concurrency?: N }`. After it, `c.data.branches = [{ index, input, dir, ok, error? }]`. Agent branches run as real concurrent OS processes; **a branch must not write shared `ctx.data`** (it races) — branches communicate via their output dirs, the join reads `data.branches`.
- **`loop`** — bounded iteration. `{ type: 'loop', steps: ['actor','critic'], join: 'synth', max: 5, exit?: (c) => c.data.agreed }`. `max` is **required** (guarantees termination); `exit` is an optional early-out. `c.data.iteration` is the 0-based counter.
- **`call`** — invoke another pipeline as a sub-machine. **`wait`** — suspend until an external signal (timer/file/shell/webhook). **`switch`** — declarative routing, no entry (first true guard wins). **`set`** — declarative `ctx.data` writes.

A branch/step state's own `<on>` is ignored — control returns to the parent's `join`.

## State Context API

### `ctx.agent(name, task, opts?)`

Run an LLM agent. `name` maps to `<agents>/<name>.md`. Returns void — agent output is files on disk.

```typescript
await ctx.agent('coder', `Implement apps/${slug}`);
await ctx.agent('research', task, { model: 'anthropic/claude-opus-4-6' });  // per-agent model
```

- Throws if prompt file doesn't exist or agent exits non-zero.
- `opts`: `{ model }` overrides the pipeline-level model; `{ inputs: ['stage', …] }` / `{ inputLists: ['branchStage', …] }` expose those upstream producers' dirs to the agent (the runtime resolves + injects them — generated pipelines fill these from the graph); `{ validate }` runs the agent under RPC and re-prompts it with the returned errors until clean.

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

```typescript
// a code state reading an upstream agent's findings and an aggregate of reviewer branches
const diff = readFileSync(join(c.dir('ingest'), 'diff.txt'), 'utf-8');
const all  = c.dirs('reviewer').map(d => JSON.parse(readFileSync(join(d, 'findings.json'), 'utf-8')));
writeFileSync(join(c.out(), 'merged.json'), JSON.stringify(all));
```

Agent states are *told* their output dir (and any upstream dirs) in the task string — they read/write files there, never `ctx.data`. For generated pipelines the visible producers are derived from the graph (see `.claude/theory/analysis.md`); you don't declare them.

### `ctx.shell(cmd, label?)`

Run shell command. Returns `true` (exit 0) or `false`. Emits `✓/✗` automatically. On failure, last 5 lines of stderr shown.

### `ctx.emit(message)` / `ctx.status(text)`

- `emit` — log message in TUI log area
- `status` — update TUI bottom status bar (model name, progress, etc.)

**Reserved emit pattern**: `── stateName ──` — used internally for state transitions. Do not emit manually.

### `ctx.retry(key)` / `ctx.retries(key)`

Counter management for retry loops. `retry()` increments and returns new count. `retries()` reads without incrementing.

### `ctx.data`

Shared in-memory **scalar** state, read by guards / `over` / `exit` / `model-expr`. Persisted for resume. Written by `code`/`set` states only — **agents run in a separate process and cannot touch `ctx.data`** (they move data through workspace files). Don't write `ctx.data` from inside a `parallel` branch (concurrent → races). To use an agent's result in a guard, add a small `code` state that reads the agent's output dir and sets a `ctx.data` value (the bridge).

### `ctx.config`

Read-only pipeline config object.

## Writing Commands

```typescript
// .reharness/commands/build.ts
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

`ctx` provides: `ctx.root` (project root), `ctx.agents` (.reharness/agents/ path), `ctx.cwd`.

## Writing Agent Prompts

Files in `.reharness/agents/<name>.md`. System prompt for autonomous Pi agent.

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
    if (!ctx.shell('npx tsc --noEmit', 'tsc')) return 'FAIL';
    if (!ctx.shell('npx jest', 'test')) return 'FAIL';
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
6. **Reserved command names**: `generate` and `evolve` are built-in commands. Project commands with these names are ignored.
