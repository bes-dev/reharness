# reharness

Deterministic multi-agent pipeline framework. Define pipelines as finite state machines — states, transitions, guards, events. Each state runs an LLM agent or deterministic code. Built-in meta-pipeline generates and evolves pipelines from natural language prompts.

## Quick Start

```bash
# Generate a pipeline for any domain
reharness generate ./my-pipeline "Pipeline for generating React Native apps from a one-line idea"

# Or generate a command for an existing project
cd my-project
reharness generate "Code review pipeline for this project"

# Run your pipelines
reharness              # Interactive TUI
reharness build myapp  # Direct command

# Improve pipelines from run history
reharness evolve
```

## Writing Pipelines

```typescript
// .reharness/commands/build.ts
import { defineCommand, definePipeline } from 'reharness';

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
├── .reharness/
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
- **Standalone**: `reharness generate ./output "Pipeline for..."` — creates new pipeline in a directory
- **In-project**: `reharness generate "Review command for this project"` — explores codebase, generates command in current `.reharness/`

### `evolve [--auto] [--interactive]`
Analyze run logs and improve the pipeline. Patches agent prompts, verify checks, scaffold, even the state graph.
- `--auto`: enable auto-evolution after every run
- `--interactive`: review and approve changes in tmux session with agent

Changes are git-versioned for easy rollback.

## CLI Options

```bash
reharness                          # Interactive TUI
reharness <command> [args...]      # Direct command
reharness --model <id>             # Override LLM model (e.g. anthropic/claude-sonnet-4-6)
reharness <command> --resume       # Resume interrupted pipeline
```

## Architecture

```
src/
├── core/              # FSM engine (standalone, no LLM dependency)
│   ├── fsm.ts         # definePipeline, validation, run loop
│   ├── agent.ts       # LLM subprocess runner (Pi-compatible)
│   ├── tmux.ts        # Tmux pane integration
│   ├── tui-app.ts     # Interactive + direct TUI
│   └── project.ts     # Auto-discover .reharness/commands/
│
├── meta/              # Pipeline generators (optional module)
│   ├── commands/      # /generate, /evolve
│   ├── agents/        # Meta-pipeline agent prompts
│   └── references/    # Design guide for pipeline generation
│
└── cli.ts             # Entry point (loads core + meta)
```

Import paths:
- `reharness` — full package (core + meta)
- `reharness/core` — FSM engine only
- `reharness/meta` — generators only

## Integrations

Reharness works standalone via CLI, but also integrates into coding agents as a tool — letting them offload structured multi-step tasks into deterministic FSM pipelines.

### MCP Server

Works with Claude Code, Cursor, and any MCP-compatible client.

```json
// .mcp.json
{
  "mcpServers": {
    "reharness": {
      "command": "reharness-mcp"
    }
  }
}
```

Exposes 5 tools: `reharness_generate`, `reharness_evolve`, `reharness_run`, `reharness_list`, `reharness_status`.

### Claude Code Skills

Copy skills to your project or globally:

```bash
cp -r integrations/claude-code/skills/* .claude/skills/
```

Three skills:
- `/reharness-generate` — generate pipelines from natural language
- `/reharness-evolve` — improve pipelines from run history
- `/reharness` — auto-invoked by Claude when task is structured (FSM accelerator)

### Pi Coding Agent

Add reharness awareness to Pi's system prompt:

```bash
cat integrations/pi/reharness-tool.md >> ~/.pi/agent/system-prompt.md
```

Pi can then invoke `reharness generate/evolve/run` via bash tool when it recognizes a structured task.

## LLM Reference

See [AGENTS.md](AGENTS.md) — documentation for LLMs creating commands, pipelines, and agent prompts.

## License

Apache 2.0
