# reharness Design Principles

## 1. Fat prompts, thin graph
Domain expertise lives in agent prompts. The FSM graph is minimal — just the skeleton connecting stages. A detailed prompt with a 5-state graph beats a generic prompt with a 15-state graph.

## 2. Constraints eliminate agents
Before adding an agent, ask: what constraints eliminate this work?

Code gen: "offline-first" → no backend agent. "No build step" → no scaffold.
Research: "bounded iterations" → no infinite loop handling. "Single output file" → no assembly.
Content: "markdown only" → no formatting agent. "No images" → no asset pipeline.

## 3. Each state proves necessity
For each state: "can the previous agent absorb this?" If yes — merge. A new state is justified by:
- **Different artifact scope** (writes different files)
- **Different toolset** (web search vs code writing vs shell commands)
- **Different iteration scope** (one-shot vs iterative loop)
- **Deterministic vs reasoning** (code state vs agent state)

## 4. One verify, all checks
Single verify state with all deterministic checks. Not multi-stage verify. Inline existence checks in entry() instead of separate gate states.

## 5. Design for weak models
Pipeline should work on a local 27B model. No review loops, no debate, no fan-out aggregate. Every token must earn its place.

## 6. Skeleton = frozen contract
Topology decided before implementation. Implement agent cannot add or remove states.

## reharness API Reference

```typescript
interface StateContext<C> {
  config: C;
  agent: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  interactive: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  shell: (cmd: string, label?: string) => boolean;
  emit: (msg: string) => void;
  status: (text: string) => void;
  retry: (key: string) => number;
  retries: (key: string) => number;
  data: Record<string, any>;
}

// Events: entry returns string → event. void → 'DONE'.
// Guards: [{ target, guard: (c) => boolean }, { target }] — first match wins.
// Final: { type: 'final', status: 'success' | 'error' }

// Cycle pattern (iterative deepening):
// assess: {
//   entry: async (c) => {
//     const gaps = findGaps(output);
//     return gaps.length > 0 ? 'GAPS' : 'ENOUGH';
//   },
//   on: {
//     ENOUGH: 'synthesize',
//     GAPS: [
//       { target: 'search', guard: (c) => c.retries('search') < 5 },
//       { target: 'synthesize' },  // proceed with what we have
//     ],
//   },
// }
```
