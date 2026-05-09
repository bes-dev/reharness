# reharness Design Principles

## 1. Layers, not perspectives
Agent boundary = file scope boundary. If two agents write different files — separate agents. If they'd read the same files with a different "concern" (security, style, perf) — that's rules in one agent's prompt, not a new agent.

## 2. Fat prompts, thin graph
Domain expertise lives in agent prompts: patterns, anti-patterns, gotchas, code examples. The FSM graph is minimal — just the skeleton connecting layers. A 400-line prompt with a 5-state graph beats a 50-line prompt with a 15-state graph.

## 3. Constraints eliminate agents
Before adding an agent, ask: what constraints eliminate this work? "Offline-first" eliminates backend/auth agents. "Single HTML file" eliminates assembly agents. "No build step" eliminates scaffold. Constraints are design decisions — encode them in the scope, not as agents.

## 4. One verify, all checks
Single verify state with all deterministic checks (compile, lint, test, stubs, antipatterns). Not verify_spec → verify_impl → verify_final. Inline existence checks (`if (!existsSync(x)) return 'ERROR'`) in state entry instead of separate gate states.

## 5. Each state proves necessity
Not "what breaks without it" (agent always justifies existence). Instead: "can the previous agent absorb this work?" If yes — merge. A new agent is justified only when it needs a different file scope or different toolset (e.g. web search vs code generation).

## 6. Design for weak models
Pipeline should work on a local 27B model. This eliminates: review loops (weak model can't self-review), debate (can't argue with itself), fan-out aggregate (three weak reviewers < one strong with good prompt). Every token must earn its place.

## 7. Skeleton = frozen contract
Topology is decided before implementation. skeleton.md defines state names, transitions, agent file scopes. The implement agent works against this contract — cannot add or remove states. Like TypeScript interfaces that logic implements against.

## reharness API Reference

```typescript
interface StateContext<C> {
  config: C;                                                    // Read-only pipeline config
  agent: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  interactive: (name: string, task: string, opts?: {model?: string}) => Promise<void>;
  shell: (cmd: string, label?: string) => boolean;              // true = exit 0
  emit: (msg: string) => void;                                  // Log to TUI
  status: (text: string) => void;                               // Status bar
  retry: (key: string) => number;                               // Increment + return
  retries: (key: string) => number;                             // Read without increment
  data: Record<string, any>;                                    // Shared state (persisted)
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
// Guards: [{ target, guard: (c) => boolean }, { target }] — first match wins.
// Final: { type: 'final', status: 'success' | 'error' }
// Reserved names: generate.ts, evolve.ts (built-in commands)

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
