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
research (agent)  — optional domain research (skipped with --fast)
prd (agent)       — distil a human-readable PRD (spec) from request + research
review_prd        — APPROVAL CHECKPOINT (the ONLY thing the human approves)
                    Approve  → design
                    Revise   → discuss_prd (interactive) → re-approve
design (agent)    — one pass: graph + per-node behavioural <contract>
construct (code)  — validate, derive inter-stage wiring from the graph, codegen
fill_prompts      — agent fills agent prompts + code-state implementations
check_dataflow    — deterministic use-before-def report (fed to polish)
polish (agent)    — one pass: review vs PRD + fix leaves (prompts/code); topology issue → redesign (rare)
verify (code)     — TS compile + structural checks → done
```

The human approves the **PRD** — confirmation the compiler understood the intent — never the FSM graph. Everything downstream is generated from the approved PRD. One checkpoint, agent-friendly: `--auto-approve` resolves it via the state's `auto-event` and emits a warning, so the same workflow serves humans and agents.

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
│   ├── generate/    # Compiler artifacts (prd.md, draft-skeleton.xml, verify-errors.md)
│   ├── feedback/    # Per-round REVISED feedback, accumulated
│   └── logs/        # Run logs
```

## Imports

- `reharness` — full public API
- `reharness/runtime` — FSM runtime only (definePipeline, types, agent runner)
- `reharness/compiler` — compilation primitives only (parse/serialize XML, codegen, verify)

## License

Apache 2.0
