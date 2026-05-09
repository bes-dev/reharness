# reharness: Designing Finite State Machines

## What is a reharness FSM?

A reharness FSM is a **finite state machine (FSM) that accomplishes a task**. Each state in the FSM either runs an AI agent that uses tools (web search, file read/write, shell commands) to do part of the work, or runs deterministic code (compile, validate, transform).

The machine **executes the task itself**. When a user says "research topic X", the FSM SEARCHES the web, READS sources, ANALYZES content, and WRITES a report. When a user says "generate an app", the FSM CREATES files, WRITES code, and VERIFIES it compiles. The FSM orchestrates execution — it is not a code generator unless the task is specifically about generating code.

## How FSMs work

A finite state machine has:
- **States**: named nodes. Each state does one unit of work.
- **Transitions**: edges between states, triggered by events.
- **Events**: strings returned by a state's entry function. "DONE", "PASS", "FAIL", "GAPS", etc.
- **Guards**: conditions on transitions. `c.retries('k') < 3` prevents infinite loops.
- **Final states**: the machine stops here. Status is "success" or "error".

The machine executes one state at a time. Each state runs, emits an event, the event selects a transition, the machine moves to the next state. This continues until a final state is reached.

## Two types of states

**Agent state**: an AI agent runs with a prompt and uses tools to accomplish work. The agent sees only its prompt + files on disk. It has tools: read, write, edit, bash, grep, find, ls, web search, fetch webpage.

**Code state**: deterministic logic. Shell commands, file checks, data transformation. No LLM, no reasoning. Fast, cheap, reproducible.

Rule: if the work can be done without reasoning — code state. If it needs understanding, creativity, or judgment — agent state.

## How to turn a user's task into an FSM

The user describes what they want. Your job is to decompose it into a sequence of states that accomplish it.

**Step 1: What is the end result?** A file? A report? A deployed app? Working code? This determines your final artifact.

**Step 2: What stages of work lead to that result?** Think backwards from the result. What must exist before the final step? What must exist before that? This gives you a chain of dependencies.

**Step 3: For each stage — agent or code?** Does it need reasoning? Agent. Is it deterministic? Code.

**Step 4: How do you know it worked?** What can you check deterministically? This becomes your verify state.

**Step 5: What can go wrong and be auto-fixed?** This gives you a fix state with a bounded retry loop.

**Step 6: Minimize.** For each state: can the previous state absorb this work? If yes — merge. A new state is justified only when the previous one genuinely cannot do this work.

## Key insight: agents USE tools to do the task

An agent in a reharness FSM is not a code writer (unless the task requires code). It's a worker with tools:
- `web search` — find information online
- `read` / `write` / `edit` — work with files
- `bash` — run commands
- `grep` / `find` — search in files

When the task is "research a topic", the search agent USES web search to find sources. It doesn't write Python code that uses web search.

When the task is "generate a mobile app", the code agent WRITES TypeScript files. The task is code generation, so the agent writes code.

The machine always DOES the task. What the agents do depends on what the task IS.

## Cycles and iteration

FSMs can have cycles. State A → State B → State A is valid. Use bounded guards to ensure termination:

```
search → assess → {ENOUGH: next, GAPS: search (if retries < 5)}
```

This is natural for tasks that need iterative deepening: research (search until enough sources), optimization (improve until good enough), generation with quality checks (generate → verify → fix → verify).

## Verification

Every machine should have a verify state that checks the output deterministically. What counts as verification depends on the task:
- Code: does it compile? does it pass tests?
- Content: does it meet word count? are citations present?
- Research: are there enough sources? is coverage sufficient?
- Data: does schema validate? are required fields present?

## Design principles

1. **Fat prompts, thin graph**: domain expertise in agent prompts, not in graph complexity.
2. **Constraints eliminate complexity**: every constraint removes work.
3. **Each state proves necessity**: can the previous state absorb this?
4. **One verify, all checks**: single verify state.
5. **Design for weak models**: no review loops, no debate. Every token earns its place.
6. **Skeleton = frozen contract**: topology decided before implementation.

## reharness API

```typescript
interface StateContext<C> {
  config: C;                          // Read-only FSM config
  agent: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  interactive: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  shell: (cmd: string, label?: string) => boolean;  // true = exit 0
  emit: (msg: string) => void;        // Log to TUI
  status: (text: string) => void;     // Status bar
  retry: (key: string) => number;     // Increment + return
  retries: (key: string) => number;   // Read without increment
  data: Record<string, any>;          // Shared state (persisted for resume)
}

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

// Events: entry returns string → event. void → 'DONE'.
// Guards: [{ target, guard: (c) => boolean }, { target }]
// Final: { type: 'final', status: 'success' | 'error' }
// Reserved command names: generate.ts, evolve.ts
```
