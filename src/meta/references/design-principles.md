# reharness: Designing Finite State Machines

## What is a reharness FSM?

A reharness FSM is a **finite state machine that accomplishes a task**. Each state either runs an AI agent (with tools: web search, file I/O, shell commands) or deterministic code (compile, validate, transform).

The machine **executes the task itself**. "Research topic X" → the FSM searches the web, reads sources, analyzes, writes a report. "Generate an app" → the FSM creates files, writes code, verifies it compiles. The FSM is not a code generator unless the task specifically requires code generation.

## How to think in FSM terms

### States are nouns — what the machine IS

Name each state as what the machine is currently doing: `searching`, `analyzing`, `verifying`, `scaffolding`. If you can't give a state a clear noun-phrase name, your decomposition is wrong.

### Events are verbs — what HAPPENS

Events are outcomes of a state's work: `DONE`, `PASS`, `FAIL`, `FOUND`, `GAPS`, `ENOUGH`, `ERROR`, `SKIP`. The entry function does work, then returns an event string that determines the next transition.

### Two types of states

**Agent state**: needs reasoning, creativity, judgment. An AI agent runs with a prompt and tools.

**Code state**: deterministic. Shell commands, file checks, data validation, transformation. No LLM. Fast, cheap, reproducible. A code state's entry function can do logic, check conditions, and return different events:

```typescript
assess: {
  entry: async (c) => {
    const sources = JSON.parse(readFileSync('sources.json', 'utf-8'));
    if (sources.length >= 10) return 'ENOUGH';
    if (c.retries('search') >= 5) return 'ENOUGH';  // budget stop
    return 'GAPS';
  },
  on: {
    ENOUGH: 'synthesize',
    GAPS: 'search',
  },
},
```

Rule: if the work can be done without reasoning — code state. If it needs understanding — agent state.

## How to design an FSM

### Step 1: Draw the happy path

Start with the simplest success scenario. What states does the machine go through from start to finish?

```
research → analyze → write_report → done
```

This is your backbone. Every other feature is an addition to this.

### Step 2: For each state — what can go wrong?

Ask: "What happens if this state fails? Can it be retried? Does it need a fix agent?" This gives you error transitions and verify/fix loops.

```
research → analyze → write_report → verify → done
                                      ↓ FAIL
                                    fix → verify (retry ≤ 3)
                                      ↓ EXHAUSTED
                                    error
```

### Step 3: Where does iteration belong?

Ask: "Does any stage need to repeat until a condition is met?" This gives you cycles with bounded guards.

```
search → assess → {ENOUGH: synthesize, GAPS: search}
```

The assess state is a CODE state — it counts sources, checks coverage, decides deterministically. The search state is an AGENT state — it reasons about what to search next.

### Step 4: Are there conditional paths?

Ask: "Does the machine need to skip or branch based on intermediate results?" Events + transitions handle this.

```
check_input: {
  entry: async (c) => {
    if (existsSync('existing-report.md')) return 'UPDATE';
    return 'CREATE';
  },
  on: {
    CREATE: 'research',
    UPDATE: 'analyze_existing',
  },
},
```

### Step 5: Where does the user need to intervene?

If the user should review or modify intermediate output, use `ctx.interactive()` — runs the agent with the same task, allowing interactive collaboration.

```
draft → interactive_review → {APPROVED: finalize, REVISE: draft}
```

### Step 6: Which agents need which model?

Expensive tasks (research, creative writing) benefit from a strong model. Mechanical tasks (fix, format) can use a cheap one. Use `{ model }` option:

```typescript
await c.agent('research', task, { model: 'anthropic/claude-opus-4-6' });
await c.agent('fix', task, { model: 'anthropic/claude-haiku-4-5' });
```

### Step 7: Verify completeness — the state × event table

For every state, list every possible event. What happens? If you can't answer — there's a gap in your design.

| State | DONE | PASS | FAIL | GAPS | ENOUGH | ERROR |
|-------|------|------|------|------|--------|-------|
| search | → assess | | | | | |
| assess | | | | → search | → synthesize | |
| synthesize | → verify | | | | | |
| verify | | → done | → fix | | | → error |

Empty cells are OK — they mean "this event can't happen in this state." But you should be conscious of each one.

### Step 8: Minimize

For each state: can the previous state absorb this work? If yes — merge. A new state is justified only when the previous one genuinely cannot do it (different tools, different iteration scope, deterministic vs reasoning).

## Design principles

1. **Expertise in prompts, not in graph**: domain knowledge belongs in agent prompts. The graph should be minimal.
2. **Constraints eliminate complexity**: every constraint removes work.
3. **Each state proves necessity**: can the previous state absorb this?
4. **One verify, all checks**: single verify state with all deterministic checks.
5. **Design for weak models**: machine should work on a local 27B model. No review loops, no debate.
6. **Skeleton = frozen contract**: topology decided before implementation.
7. **States communicate through files**: one state writes files, next state reads them. Pure functions of the filesystem.
8. **Code over agents**: if the work is mechanical (read file, transform, validate, fetch URL, parse) — it MUST be a code state. Agent states are ONLY for work that requires reasoning, creativity, or judgment. Reading a file and writing it elsewhere is not reasoning.
9. **Internalize at design time, not at runtime**: external resources (repos, APIs, design systems, schemas) must be studied during /generate and reproduced locally — adapted, minimized, embedded into .reharness/ or project files. The generated FSM must NOT fetch, clone, or download anything at runtime (unless the task itself requires internet access, like web research). Runtime dependencies on external repos are an anti-pattern.
10. **Validate with helpful errors**: code states that validate input must show allowed values on failure. If a parameter accepts one of N options, list them. The user should never have to read source code to understand what inputs are valid.

## reharness API

```typescript
interface StateContext<C> {
  config: C;                          // Read-only FSM config
  agent: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  interactive: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  shell: (cmd: string, label?: string) => boolean;  // true = exit 0
  emit: (msg: string) => void;        // Log to TUI
  status: (text: string) => void;     // Status bar
  retry: (key: string) => number;     // Increment + return count
  retries: (key: string) => number;   // Read count without increment
  data: Record<string, any>;          // Shared state (persisted for resume)
}

// Entry function: does work, returns event string (or void = 'DONE')
// Events select transitions:
//   on: 'next_state'                        — shorthand for { DONE: 'next_state' }
//   on: { PASS: 'a', FAIL: 'b' }           — branching
//   on: { FAIL: [                           — guarded transitions (first match wins)
//     { target: 'fix', guard: (c) => c.retries('v') < 3 },
//     { target: 'error' },                  — fallback (no guard = always matches)
//   ]}

// Final states:
//   done:  { type: 'final', status: 'success' }
//   error: { type: 'final', status: 'error' }

// Exit actions (cleanup after leaving a state):
//   exit: async (c) => { /* cleanup */ }

// Command structure:
import { defineCommand, definePipeline } from 'reharness';
export default defineCommand({
  description: '...',
  usage: '<args>',
  run: (args, ctx) => definePipeline({
    config: { ... },
    agents: ctx.agents,
    cwd: ctx.cwd,
    initial: 'first_state',
    states: { ... },
  }),
});

// Reserved command names: generate.ts, evolve.ts
```

## Skeleton JSON format

The skeleton agent outputs a JSON file that is compiled into TypeScript deterministically. No LLM interprets it.

```json
{
  "id": "my-fsm",
  "description": "What this FSM does",
  "usage": "<query>",
  "initial": "first_state",
  "states": {
    "first_state": {
      "type": "agent",
      "on": { "DONE": "next", "ERROR": "error" }
    },
    "check": {
      "type": "code",
      "on": {
        "PASS": "done",
        "FAIL": [
          { "target": "fix", "guard": "retries:verify<3" },
          { "target": "error" }
        ]
      }
    },
    "done": { "type": "final", "status": "success" },
    "error": { "type": "final", "status": "error" }
  }
}
```

- `"agent"` states: AI agent, prompt = agents/<state-name>.md
- `"code"` states: deterministic logic, function = lib/<id>-states.ts
- `"final"` states: terminal, with `"status"`
- Guards: `"retries:key<N"` → `c.retries('key') < N`
