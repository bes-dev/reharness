# reharness

Conversational compiler for AI workflows. Compile a recurring AI task — described in natural language — into a deterministic FSM with explicit human (or agent) checkpoints. The compiled artifact is a persistent, version-controllable directory of XML + TypeScript that any conformant runtime can execute cheaply on small models.

## Quick Start

```bash
# Interactive: design + checkpoint + construct
reharness generate "Code review FSM for this project"

# Agent-driven: skip checkpoint, resolve via auto-event
reharness generate --auto-approve "FSM for generating React Native apps from a one-line idea"

# Run a compiled FSM
reharness                  # Interactive TUI
reharness <command> args   # Direct
```

## How `generate` works

```
analyze (agent)   — writes scope.md + draft-skeleton.xml
review_design     — APPROVAL CHECKPOINT
                    Approve  → construct
                    Revise   → analyze (with accumulated feedback)
construct (code)  — validate, copy to skeletons/, codegen
fill_prompts      — agent fills agent prompts + code-state implementations
verify (code)     — TS compile + structural checks
                    PASS → done
                    FAIL → fill_prompts (≤2 retries) → error
```

One checkpoint, agent-friendly. `--auto-approve` resolves it via the state's `auto-event` and emits a warning — same workflow serves humans and agents.

## Writing a pipeline by hand

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
        entry: async (c) => c.shell('npx tsc --noEmit') ? 'PASS' : 'FAIL',
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

## State types

| Type       | Behavior |
|------------|----------|
| `agent`    | LLM agent runs under the state's harness (prompt + tools + contract). |
| `code`     | Deterministic TypeScript function. Returns an event string. |
| `approval` | Runtime pauses, shows artifacts, awaits a chosen event. `auto-event` resolves it in auto-approve mode. |
| `final`    | Terminal: `status: success | error`. |

## CLI

```bash
reharness                                  # Interactive TUI
reharness <command> [args...]              # Direct run
reharness generate <description>           # Compile a new workflow (interactive checkpoint)
reharness generate --auto-approve <desc>   # Compile autonomously (for agent invocation)
reharness --model anthropic/claude-sonnet-4-6 ...
reharness <command> --resume               # Resume an interrupted run
```

## Project structure

```
my-project/
├── .reharness/
│   ├── skeletons/   # Source of truth — one .xml per command
│   ├── commands/    # Generated from skeletons — do not edit
│   ├── agents/      # Agent prompts (edit freely)
│   ├── lib/         # Code-state implementations (edit freely)
│   ├── generate/    # Compiler artifacts (scope.md, draft-skeleton.xml, verify-errors.md)
│   ├── feedback/    # Per-round REVISED feedback, accumulated
│   └── logs/        # Run logs
```

## Imports

- `reharness` — full public API
- `reharness/runtime` — FSM runtime only (definePipeline, types, agent runner)
- `reharness/compiler` — compilation primitives only (parse/serialize XML, codegen, verify)

## License

Apache 2.0
