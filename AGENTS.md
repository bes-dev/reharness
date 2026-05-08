# pi-fsm — LLM Reference

You are working with pi-fsm, a finite state machine framework for multi-agent pipelines. It orchestrates Pi coding agents as states in an FSM with typed transitions, guards, and events.

## Core Concepts

**Pipeline** — a finite state machine. States execute entry actions and emit events. Events trigger transitions to the next state. Guards conditionally select transitions. Final states end the pipeline.

**State** — has an `entry` action (async function) and transitions (`on`). Entry returns an event name (string) or void (= `DONE` event).

**Transition** — maps event to target state. Can have guards (conditions). Array of targets = first matching guard wins.

**Agent** — a Pi coding agent subprocess. Gets a markdown prompt (`.md`) and a task string. Runs autonomously with tools (read/write/edit/bash/grep/find).

**Command** — user-facing entry point in `.pi-fsm/commands/`. Parses arguments, constructs a pipeline, returns it.

## Project Structure

```
project/
├── .pi-fsm/
│   ├── agents/           # Agent prompt files (.md)
│   ├── commands/          # Each file = one slash command, auto-discovered
│   └── lib/               # Shared code
└── output/
```

## Writing a Pipeline

```typescript
import { definePipeline } from 'pi-fsm';

definePipeline({
  config: { slug, idea },
  initial: 'plan',           // Start state (must exist)
  agents: ctx.agents,        // Optional, defaults to .pi-fsm/agents/

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

## State Context API

### `ctx.agent(name, task, opts?)`

Run an LLM agent. `name` maps to `<agents>/<name>.md`. Returns void — agent output is files on disk.

```typescript
await ctx.agent('coder', `Implement apps/${slug}`);
await ctx.agent('research', task, { model: 'anthropic/claude-opus-4-6' });  // per-agent model
```

- Throws if prompt file doesn't exist or agent exits non-zero.
- Optional `{ model }` overrides the pipeline-level model for this call.

### `ctx.interactive(name, task, opts?)`

Run an interactive LLM session in a tmux pane. User can collaborate with the agent. Pipeline blocks until session ends. Requires tmux.

```typescript
await ctx.interactive('reviewer', 'Review the outline and suggest changes');
```

### `ctx.shell(cmd, label?)`

Run shell command. Returns `true` (exit 0) or `false`. Emits `✓/✗` automatically. On failure, last 5 lines of stderr shown.

### `ctx.emit(message)` / `ctx.status(text)`

- `emit` — log message in TUI log area
- `status` — update TUI bottom status bar (model name, progress, etc.)

**Reserved emit pattern**: `── stateName ──` — used internally for state transitions. Do not emit manually.

### `ctx.retry(key)` / `ctx.retries(key)`

Counter management for retry loops. `retry()` increments and returns new count. `retries()` reads without incrementing.

### `ctx.data`

Shared mutable state between states. Persisted for resume.

### `ctx.config`

Read-only pipeline config object.

## Writing Commands

```typescript
// .pi-fsm/commands/build.ts
import { defineCommand, definePipeline } from 'pi-fsm';

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

`ctx` provides: `ctx.root` (project root), `ctx.agents` (.pi-fsm/agents/ path), `ctx.cwd`.

## Writing Agent Prompts

Files in `.pi-fsm/agents/<name>.md`. System prompt for autonomous Pi agent.

Guidelines:
- Keep focused — one agent, one job
- Include explicit constraints (what NOT to do)
- Reference file paths relative to pipeline's `cwd`
- Include verification commands ("Run npx tsc --noEmit after changes")
- Agent has tools: read, write, edit, bash, grep, find, ls
- Agent does NOT see other agents' output — only files on disk

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

```typescript
analyze: {
  entry: async (ctx) => {
    const output = await ctx.agent('analyzer', 'Analyze codebase');
    ctx.data.issues = output;
  },
  on: 'fix',
},
fix: {
  entry: async (ctx) => {
    await ctx.agent('fixer', `Fix:\n${ctx.data.issues}`);
  },
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
