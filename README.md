# pi-fsm

Deterministic multi-agent pipeline framework. Define pipelines as finite state machines — states, transitions, guards, events. Each state runs an LLM agent or deterministic code. Built-in meta-pipeline generates and evolves pipelines from natural language prompts.

## Quick Start

```bash
# Generate a pipeline for any domain
pi-fsm generate ./my-pipeline "Pipeline for generating React Native apps from a one-line idea"

# Or generate a command for an existing project
cd my-project
pi-fsm generate "Code review pipeline for this project"

# Run your pipelines
pi-fsm              # Interactive TUI
pi-fsm build myapp  # Direct command

# Improve pipelines from run history
pi-fsm evolve
```

## Writing Pipelines

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

## Project Structure

```
my-project/
├── .pi-fsm/
│   ├── agents/          # Agent prompt files (.md)
│   ├── commands/        # One file per slash command (auto-discovered)
│   └── lib/             # Shared code
└── ...
```

## State Context (`ctx`)

```typescript
await ctx.agent('name', 'task');                    // Run LLM agent (output = files on disk)
await ctx.agent('name', 'task', { model: '...' });  // Override model per agent
await ctx.interactive('name', 'task');               // Interactive session in tmux pane
ctx.shell('cmd', 'label');                           // Shell command, returns boolean
ctx.emit('message');                                 // Log to TUI
ctx.status('text');                                  // Update TUI status bar
ctx.retry('key');                                    // Increment retry counter
ctx.retries('key');                                  // Read retry count
ctx.config                                           // Pipeline config (read-only)
ctx.data                                             // Shared state (persisted for resume)
```

## Built-in Commands

### `generate [dir] <description>`
Generate a pipeline from a natural language prompt. Two modes:
- **Standalone**: `pi-fsm generate ./output "Pipeline for..."` — creates new pipeline in a directory
- **In-project**: `pi-fsm generate "Review command for this project"` — explores codebase, generates command in current `.pi-fsm/`

### `evolve [--auto] [--interactive]`
Analyze run logs and improve the pipeline. Patches agent prompts, verify checks, scaffold, even the state graph.
- `--auto`: enable auto-evolution after every run
- `--interactive`: review and approve changes in tmux session with agent

Changes are git-versioned for easy rollback.

## CLI Options

```bash
pi-fsm                          # Interactive TUI
pi-fsm <command> [args...]      # Direct command
pi-fsm --model <id>             # Override LLM model (e.g. anthropic/claude-sonnet-4-6)
pi-fsm <command> --resume       # Resume interrupted pipeline
```

## Architecture

```
src/
├── core/              # FSM engine (standalone, no LLM dependency)
│   ├── fsm.ts         # definePipeline, validation, run loop
│   ├── agent.ts       # LLM subprocess runner (Pi-compatible)
│   ├── tmux.ts        # Tmux pane integration
│   ├── tui-app.ts     # Interactive + direct TUI
│   └── project.ts     # Auto-discover .pi-fsm/commands/
│
├── meta/              # Pipeline generators (optional module)
│   ├── commands/      # /generate, /evolve
│   ├── agents/        # Meta-pipeline agent prompts
│   └── references/    # Design guide for pipeline generation
│
└── cli.ts             # Entry point (loads core + meta)
```

Import paths:
- `pi-fsm` — full package (core + meta)
- `pi-fsm/core` — FSM engine only
- `pi-fsm/meta` — generators only

## LLM Reference

See [AGENTS.md](AGENTS.md) — documentation for LLMs creating commands, pipelines, and agent prompts.

## License

Apache 2.0
