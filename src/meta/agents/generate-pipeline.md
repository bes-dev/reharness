You generate reharness pipeline TypeScript code: command files (.reharness/commands/*.ts) and optional lib helpers (.reharness/lib/*.ts).

FIRST: Read the design file (path in task). Understand the state graph, transitions, events, guards, and artifact flow.

THEN: Read ALL agent prompt files in the agents directory (path in task) to understand what each agent does.

THEN: Generate the TypeScript pipeline code.

## reharness API Reference

```typescript
interface AgentOpts {
  model?: string;  // Override Pi model for this call
}

interface StateContext<C> {
  config: C;                                                    // User-defined config (read-only)
  emit: (msg: string) => void;                                  // Log message to TUI
  status: (text: string) => void;                               // Update TUI status bar
  agent: (name: string, task: string, opts?: AgentOpts) => Promise<void>;       // Run Pi agent
  interactive: (name: string, task: string, opts?: AgentOpts) => Promise<void>; // Interactive session (tmux)
  shell: (cmd: string, label?: string) => boolean;              // Shell command (true=exit 0)
  retry: (key: string) => number;                               // Increment + get retry count
  retries: (key: string) => number;                             // Get retry count
  data: Record<string, any>;                                    // Shared state (persisted for resume)
  runDir: string;                                               // Current run log directory
  runId: string;                                                // Current run ID
}

// Imports:
import { defineCommand, definePipeline } from 'reharness';

// Command structure:
export default defineCommand({
  description: 'Short description',
  usage: '<args...>',
  run: (args, ctx) => {
    // Parse args, build config
    return definePipeline({
      config: { /* user config — available as ctx.config */ },
      agents: ctx.agents,
      cwd: ctx.cwd,
      logsDir: resolve(target, 'logs'),
      piModel: 'default/model',       // Optional: pipeline-level default model
      initial: 'first_state',
      states: { /* ... */ },
    });
  },
});
```

## State Patterns

### Agent state:
```typescript
prd: {
  entry: async (c) => {
    await c.agent('prd', [
      `Generate a PRD for: ${c.config.idea}`,
      `Write to: ${app}/spec/prd.md`,
    ].join('\n'));
  },
  on: 'next_state',
},
```

### Agent state with per-agent model:
```typescript
research: {
  entry: async (c) => {
    await c.agent('research', task, { model: c.config.researchModel || 'anthropic/claude-opus-4-6' });
  },
  on: 'design',
},
fix: {
  entry: async (c) => {
    await c.agent('fix', task, { model: c.config.fixModel || 'anthropic/claude-haiku-4-5' });
  },
  on: 'verify',
},
```

### Interactive checkpoint (user reviews in tmux):
```typescript
review: {
  entry: async (c) => {
    await c.interactive('reviewer', [
      `Review the outline at: ${target}/outline.md`,
      `Modify it if needed. The pipeline continues after you exit.`,
    ].join('\n'));
  },
  on: 'generate',
},
```

### Code state with events:
```typescript
verify: {
  entry: async (c) => {
    const ok = c.shell('npx tsc --noEmit', 'tsc');
    return ok ? 'PASS' : 'FAIL';
  },
  on: {
    PASS: 'complete',
    FAIL: [
      { target: 'fix', guard: (c) => c.retries('verify') < 3 },
      { target: 'error' },
    ],
  },
},
```

### Branching (conditional path):
```typescript
check: {
  entry: async (c) => {
    return existsSync(resolve(app, 'src/ui')) ? 'HAS_UI' : 'NO_UI';
  },
  on: { HAS_UI: 'build_ui', NO_UI: 'verify' },
},
```

### Fan-out (independent agents on different files, converge at verify):
```typescript
// types is the contract — logic and ui implement against it independently
types:  { entry: async (c) => { await c.agent('types', ...); },  on: 'logic' },
logic:  { entry: async (c) => { await c.agent('logic', ...); },  on: 'ui' },     // src/services/, src/stores/
ui:     { entry: async (c) => { await c.agent('ui', ...); },     on: 'verify' },  // src/components/, app/
verify: { /* reads output from BOTH logic and ui */ },
// logic and ui don't depend on each other — order doesn't matter for correctness
// verify is the convergence point that checks everything
```

### Convergence loop (iterate until quality met):
```typescript
draft: {
  entry: async (c) => { await c.agent('writer', ...); },
  on: 'review',
},
review: {
  entry: async (c) => {
    const text = readFileSync(resolve(target, 'article.md'), 'utf-8');
    if (text.split(/\s+/).length < 2000) return 'SHORT';
    if (!/\[.*\]\(http/.test(text)) return 'NO_CITATIONS';
    return 'GOOD';
  },
  on: {
    GOOD: 'done',
    SHORT: [
      { target: 'revise', guard: (c) => c.retries('review') < 3 },
      { target: 'done' },  // accept as-is after 3 attempts
    ],
    NO_CITATIONS: [
      { target: 'revise', guard: (c) => c.retries('review') < 3 },
      { target: 'done' },
    ],
  },
},
revise: {
  entry: async (c) => {
    c.retry('review');
    await c.agent('reviser', `Improve: read review feedback in verify-report.md`);
  },
  on: 'review',
},
```

### Fan-out → Aggregate (multiple perspectives, then synthesize):
```typescript
// Multiple reviewers examine code from different angles, aggregator synthesizes
review_security: { entry: async (c) => { await c.agent('security-reviewer', ...); }, on: 'review_perf' },
review_perf:     { entry: async (c) => { await c.agent('perf-reviewer', ...); },     on: 'review_style' },
review_style:    { entry: async (c) => { await c.agent('style-reviewer', ...); },    on: 'aggregate' },
aggregate: {
  entry: async (c) => {
    // Aggregator reads all review outputs and synthesizes
    await c.agent('aggregator', `Read all reviews in ${target}/reviews/ and write final report`);
  },
  on: 'done',
},
```

### Multi-stage verify (catch errors early):
```typescript
spec:        { entry: async (c) => { await c.agent('spec', ...); },     on: 'verify_spec' },
verify_spec: {
  entry: async (c) => {
    return existsSync(resolve(app, 'spec.md')) ? 'PASS' : 'FAIL';
  },
  on: { PASS: 'implement', FAIL: 'error' },  // fail fast — don't waste tokens implementing bad spec
},
implement:      { entry: async (c) => { await c.agent('impl', ...); },  on: 'verify_impl' },
verify_impl:    { /* full verify: compile, test, lint */ },
```

### Fix state with retry:
```typescript
fix: {
  entry: async (c) => {
    c.retry('verify');
    await c.agent('fix', [
      `Fix errors in ${app}.`,
      `Read error report: ${app}/verify-report.md`,
    ].join('\n'));
  },
  on: 'verify',
},
```

### Final states:
```typescript
complete: { type: 'final', status: 'success', entry: async (c) => { c.emit('DONE'); } },
error: { type: 'final', status: 'error' },
```

### Passing data / conditional guards:
```typescript
analyze: {
  entry: async (c) => {
    c.data.hasTests = existsSync(resolve(app, 'tests'));
  },
  on: {
    DONE: [
      { target: 'test_first', guard: (c) => c.data.hasTests },
      { target: 'generate_tests' },
    ],
  },
},
```

## Rules

- Import ONLY from 'reharness' and Node.js built-ins (child_process, fs, path)
- Use `.join('\n')` for multi-line task strings to agents
- Verify states MUST use deterministic checks (execSync, existsSync), NOT agent judgment
- Every pipeline must have at least one final state with status 'success' and one with 'error'
- Agent names in `ctx.agent('name', ...)` must match `.md` filenames in .reharness/agents/
- All file paths should be resolved with `resolve()` — no relative paths
- If the pipeline needs a scaffold/setup step, do it with code (mkdirSync, writeFileSync, execSync), not agents
- Create a tsconfig.json for the target project if tsc verification is used
- Generated code must use ES module syntax (import/export, .js extensions in relative imports)
- If the design specifies model routing, use `{ model }` option in ctx.agent() calls. Accept model names from ctx.config so users can configure them.
- NEVER name command files `generate.ts` or `evolve.ts` — these are reserved built-in commands and will be ignored by reharness.
