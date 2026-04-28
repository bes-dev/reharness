# pi-fsm

Deterministic multi-agent pipeline framework for [Pi coding agent](https://github.com/badlogic/pi-mono).

Define pipelines as finite state machines — states, transitions, guards, events. Each state runs a Pi agent (LLM with tools) or deterministic code. Full TUI with multiline editing, autocomplete, and abort. ~1300 lines, 2 dependencies.

## Quick Start

```typescript
// .pi-fsm/commands/build.ts
import { defineCommand, definePipeline } from 'pi-fsm';

export default defineCommand({
  description: 'Build something',
  usage: '<name>',
  run: (args, ctx) => definePipeline({
    config: { name: args[0] },
    initial: 'plan',
    states: {
      plan:   { entry: async (c) => { await c.agent('planner', 'Plan'); },  on: 'code' },
      code:   { entry: async (c) => { await c.agent('coder', 'Build'); },   on: 'verify' },
      verify: {
        entry: async (c) => {
          return c.shell('npx tsc --noEmit') ? 'PASS' : 'FAIL';
        },
        on: {
          PASS: 'done',
          FAIL: [
            { target: 'fix', guard: (c) => c.retries('v') < 3 },
            { target: 'error' },
          ],
        },
      },
      fix:    { entry: async (c) => { c.retry('v'); await c.agent('fixer', 'Fix'); }, on: 'verify' },
      done:   { type: 'final', status: 'success' },
      error:  { type: 'final', status: 'error' },
    },
  }),
});
```

```bash
pi-fsm              # Interactive TUI
pi-fsm build myapp  # Direct command
```

## Project Structure

```
my-project/
├── .pi-fsm/
│   ├── agents/          # Agent prompt files (.md)
│   ├── commands/        # One file per slash command (auto-discovered)
│   └── lib/             # Shared code
└── output/
```

## FSM API

### `definePipeline(options)`

```typescript
definePipeline({
  config: { ... },         // Available as ctx.config
  initial: 'firstState',   // Start state
  agents: ctx.agents,      // Agent prompts dir (optional, defaults to .pi-fsm/agents/)
  cwd: ctx.cwd,            // Working directory (optional)
  logsDir: './logs',       // Run logs (optional)

  states: {
    // Linear state — entry runs, then auto-transitions via DONE event
    myState: {
      entry: async (ctx) => { await ctx.agent('name', 'task'); },
      on: 'nextState',  // shorthand for { DONE: 'nextState' }
    },

    // Branching state — entry returns event name
    check: {
      entry: async (ctx) => {
        return ok ? 'PASS' : 'FAIL';  // event name (void = 'DONE')
      },
      on: {
        PASS: 'success',
        FAIL: [
          { target: 'fix', guard: (ctx) => ctx.retries('k') < 3 },
          { target: 'error' },  // fallback (no guard = always matches)
        ],
      },
    },

    // Final states — pipeline ends here
    success: { type: 'final', status: 'success', entry: async (ctx) => { ctx.emit('Done!'); } },
    error:   { type: 'final', status: 'error' },
  },
});
```

### Validation

`definePipeline()` validates at definition time:
- `initial` state exists
- All transition targets reference existing states
- At least one final state defined

Typos in state names throw immediately, not at runtime.

### State Context (`ctx`)

```typescript
await ctx.agent('name', 'task');  // Run Pi agent, returns text output
ctx.shell('cmd', 'label');        // Run shell, returns boolean, auto-emits ✓/✗
ctx.emit('message');              // Log to TUI
ctx.status('text');               // Update TUI status bar
ctx.retry('key');                 // Increment retry counter
ctx.retries('key');               // Read retry count
ctx.config                        // Pipeline config (read-only)
ctx.data                          // Shared state between states (persisted for resume)
ctx.runDir                        // Current run log directory
```

### `defineCommand(options)`

One file per command in `.pi-fsm/commands/`. Auto-discovered by filename.

```typescript
defineCommand({
  description: string,
  usage?: string,
  run: (args, ctx) => Pipeline | null,
})
// ctx.root — project root
// ctx.agents — resolved path to .pi-fsm/agents/
// ctx.cwd — working directory
```

## TUI

Interactive mode features:
- Multiline editing (Shift+Enter), Emacs keybindings, history, undo
- Tab autocomplete for `/commands`
- Pipeline visualization: step status with ✓/✗/spinner + elapsed time
- Status bar: model name, token count, key hints
- Esc×2 or Ctrl+C to abort running pipeline (kills agent subprocess, saves state for resume)
- Ctrl+C×2 to exit

## Resume

```bash
pi-fsm build myapp --resume     # Continues from last saved state
```

## Architecture

```
.pi-fsm/commands/     Your code: defineCommand → definePipeline
.pi-fsm/agents/       Agent prompts (.md)
.pi-fsm/lib/          Shared helpers

pi-fsm (1335 lines, 2 deps)
  ├── FSM engine      states → events → transitions → guards → final states
  ├── Agent runner    spawn Pi subprocess, parse JSON events, track tokens
  ├── Project loader  auto-discover .pi-fsm/commands/
  └── TUI             pi-tui: differential rendering, editor, pipeline view

Pi (vanilla)
  └── LLM + tools (read/write/edit/bash/grep/find)
```

## LLM Reference

See [AGENTS.md](AGENTS.md) — documentation for LLMs creating commands, pipelines, and agent prompts.

## License

Apache 2.0
