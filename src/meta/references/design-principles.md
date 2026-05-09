# reharness Design Principles

## 1. Fat prompts, thin graph
Domain expertise lives in agent prompts. The FSM graph is minimal — just the skeleton connecting stages.

## 2. Constraints eliminate complexity
Before adding anything, ask: what constraints eliminate this work? The more constraints you find, the simpler the pipeline.

## 3. Each state proves necessity
For each state: "can the previous agent absorb this?" If yes — merge. A new state is justified when the previous agent genuinely cannot do this work.

## 4. One verify, all checks
Single verify state with all deterministic checks. Inline existence checks in entry() instead of separate gate states.

## 5. Design for weak models
Pipeline should work on a local 27B model. Every token must earn its place.

## 6. Skeleton = frozen contract
Topology decided before implementation. Implement agent cannot add or remove states.

## reharness API Reference

```typescript
interface StateContext<C> {
  config: C;                          // Read-only pipeline config
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

// State types:
// Agent state: entry calls ctx.agent(), returns event string or void (='DONE')
// Code state: entry runs deterministic logic (ctx.shell, execSync, file checks)
// Final state: { type: 'final', status: 'success' | 'error' }

// Events and transitions:
// on: 'next'                    — shorthand for { DONE: 'next' }
// on: { PASS: 'a', FAIL: 'b' } — branching on events
// Guards: [{ target: 'a', guard: (c) => c.retries('k') < 3 }, { target: 'b' }]

// Cycles (bounded iteration):
// state_a does work → state_b checks result → {GOOD: next, RETRY: state_a}
// Always use guard with retries to ensure termination

// Reserved command names: generate.ts, evolve.ts
```
