# Pipeline Design Guide

Reference for designing reharness pipelines. Read this before designing a state graph.

## reharness Capabilities

### States and transitions
- **Active state**: has `entry()` that returns an event string (or void = `DONE`), plus `on` transitions
- **Final state**: `{ type: 'final', status: 'success' | 'error' }` — pipeline ends here
- **Events**: entry returns a string → that string is the event that selects the transition
- **Guards**: array of `{ target, guard }` — first matching guard wins, no-guard = fallback
- **Retry counters**: `ctx.retry(key)` / `ctx.retries(key)` — for bounded loops

### Context API
- `ctx.agent(name, task, opts?)` — run Pi agent. Returns void. Output is files on disk. Optional `opts: { model?: string }` overrides the model for this call.
- `ctx.interactive(name, task, opts?)` — run interactive Pi session in tmux pane. User can collaborate with agent. Same `opts` for model override.
- `ctx.shell(cmd, label)` — run shell command, returns boolean (exit 0 = true)
- `ctx.emit(msg)` — log to TUI
- `ctx.data` — shared state between states (persisted for resume)
- `ctx.config` — read-only pipeline config

### Per-agent model selection
Different agents can use different models. The `model` option in `ctx.agent()` overrides the pipeline-level default:
```typescript
await ctx.agent('research', task, { model: 'anthropic/claude-opus-4-6' });   // expensive, deep reasoning
await ctx.agent('fix', task, { model: 'anthropic/claude-haiku-4-5' });       // cheap, mechanical fixes
await ctx.agent('design', task);                                              // uses pipeline default
```
Model priority: per-agent opts > CLI `--model` flag > `PipelineDefinition.piModel` > Pi default.

Pipelines can accept model configuration from user input via `ctx.config` and route it to agents dynamically.

### Agents
- Each agent gets a markdown prompt (.md) and a task string
- Agent has tools: read, write, edit, bash, grep, find, ls, search (web), fetch_webpage
- Agent sees ONLY its prompt + files on disk — no shared memory with other agents
- Agent output is files it creates/modifies, NOT return values

### Validation
- `definePipeline()` validates at definition time: all transition targets exist, initial state exists, at least one final state
- State name typos caught immediately, not at runtime

## Deriving Pipeline Topology

Don't pick a pattern from a menu. Analyze the task along 5 axes — the topology follows from the analysis.

### Axis 1: Artifact structure — what is produced?

| Structure | Topology implication |
|---|---|
| Single file (article, presentation, config) | Linear pipeline |
| File tree with dependencies (types → impl → UI) | Fan-out: contract → independent branches → verify convergence |
| Independent artifacts (multiple reviews, translations) | Fan-out → aggregate |
| Layered artifacts (spec → design → code → tests) | Multi-stage with early verify between layers |

### Axis 2: Verification nature — how is result checked?

| Verification | Topology implication |
|---|---|
| Deterministic (compile, lint, schema validate) | Code verify state with verify/fix loop |
| Heuristic (word count, coverage, structure checks) | Code verify with soft events (SHORT, NO_CITATIONS, GOOD) |
| Subjective (quality, style, correctness) | Interactive checkpoint (`ctx.interactive`) or convergence loop |
| None (pure creative output) | No verify/fix loop. Linear with optional human review |

### Axis 3: Error recoverability — can errors be auto-fixed?

| Recoverability | Topology implication |
|---|---|
| Syntax/structural errors | Fix agent + retry loop (max 3) |
| Content gaps | Convergence loop: review → revise → review |
| Design-level errors | Multi-stage verify: catch at spec stage before expensive implementation |
| Unrecoverable | Fail fast to error state, no retry |

### Axis 4: Expertise diversity — how many perspectives?

| Diversity | Topology implication |
|---|---|
| Single expertise | Single agent, linear |
| Multiple expertise, different files | Fan-out: each agent works on its own files, converge at verify |
| Multiple expertise, same artifact | Fan-out → aggregate: each reviews independently, aggregator synthesizes |
| Opposing perspectives | Actor-critic / debate loop |

### Axis 5: Instance variability — what changes between runs?

| Variability | Topology implication |
|---|---|
| Structure constant, content varies | Scaffold (code state) + generate (agent states) |
| Structure also varies | Planning state before scaffold to determine structure |
| Fully dynamic | Branching/conditional states with guards |

### Model routing
Different agents can use different models via `{ model }` option. Expensive models for creative/research, cheap for mechanical fixes. Models from user input via `ctx.config`.

## Design Principles

### Contract-first decomposition
When generating code or structured content, separate **specification** from **implementation**:
1. First agent produces the contract (types, interfaces, outline, schema, manifest)
2. Next agent(s) implement against the frozen contract
3. Verify checks that implementation matches contract

This gives clear artifact boundaries and typed verification between layers. But it's a principle, not a rule — some domains don't need contracts (e.g. single-file generation).

### Validate early, not just at the end
The #1 root cause of agentic system failures is **Data Schema Mismatch** (28% of all faults) — when one agent's output doesn't match the next agent's expected input. These mismatches propagate through the pipeline and surface as cryptic errors in later states.

**Don't wait for a final verify to catch this.** Add gate states between agent states:

```
spec → gate_spec → implement → gate_impl → ui → verify_all
```

Each gate is a cheap code state that checks: does the previous agent's output exist, is it valid, does it match the expected schema? If not, fail early — before the next agent wastes tokens on bad input.

Gate checks are fast (file exists, JSON parses, key fields present, types compile). They catch 28% of all agentic failures at the point of origin, not after propagation.

**Propagation rule:** errors introduced early surface as symptoms late. A missing type in skeleton → type error in logic → runtime crash in UI → verify catches it but fix agent doesn't know the root cause is in skeleton. Inter-state gates prevent this cascade.

### Agent granularity
Split agents when they work on **different files** or need **different domain knowledge**. Don't split just for the sake of splitting.

Good split: `logic` agent (services, stores) + `ui` agent (components, screens) — different files, different expertise.
Bad split: `header` agent + `footer` agent — same file, same knowledge, artificial boundary.

A single agent that generates a 200-line HTML file is fine. Five agents each writing 40 lines of the same file is not.

### Code states — not just scaffold and verify
Any step that is deterministic should be a code state, not an agent. Agents are expensive and non-deterministic — use them only when you need reasoning.

Examples of code states:
- **Scaffold**: create dirs, install deps, write config files
- **Verify**: run tsc, lint, tests, check file existence
- **Transform**: convert formats (CSV→JSON, merge files, run scripts)
- **Package**: zip, build, deploy
- **Gate**: check preconditions before expensive agent steps (does spec exist? does it compile?)
- **Aggregate**: concatenate outputs from multiple agents into one file for the next state

Rule of thumb: if you can write it as a shell command or a few lines of Node.js — code state. If it needs reasoning about content — agent state.

### Verification depth
The verify state is the most important state in the pipeline. Bad verify = bad pipeline.

**Level 1 — Existence**: file exists, non-empty
**Level 2 — Syntax**: JSON parses, HTML validates, JS syntax OK, types compile
**Level 3 — Structure**: section count, word count, required fields present, coverage checks
**Level 4 — Semantics**: stub detection, antipattern grep, contract coverage (outline sections in output)
**Level 5 — Runtime**: smoke test, integration test, simulator launch

Go as deep as the domain allows. Every check you add is an error the fix agent can automatically resolve.

### Fix agent contract
The fix agent MUST:
- Read the exact error report (verify-report.md)
- Fix ONLY listed errors
- NOT refactor, improve, or restructure

The fix agent MUST NOT make creative decisions. It's a surgeon, not an architect.

## Quality Standards

A well-designed pipeline is not just correct — it's deep. Here's what separates shallow from production-quality:

### Spec/contract quality
Shallow: "generate a plan" → vague prose the next agent interprets loosely.
Deep: spec agent produces a **structured, parseable artifact** with explicit inclusion/exclusion decisions (what's in scope, what's not), enumerated entities with fields and types, and screen/component/endpoint inventory. The spec should be specific enough that two different implementation agents would produce similar results.

Techniques: MUST/WONT matrices, entity-field tables, interface signatures with doc comments explaining edge cases and invariants, explicit non-goals section.

### Agent prompt quality
Shallow: "implement the app based on the spec."
Deep: agent prompt contains **domain-specific patterns** (code examples, structural templates, naming conventions), **anti-patterns** (what NOT to do and why), **platform gotchas** (runtime limitations, API quirks found via research), and **self-verification** instructions ("run X after finishing").

Each prompt should be self-contained: an agent reading only its prompt + files on disk must be able to do its job without guessing.

### Scaffold completeness
Shallow: install 2-3 core packages, let agents figure out the rest.
Deep: scaffold installs **every package** agents will need upfront. Install failures during generation are hard to recover from — agents can't reliably run package managers. Pre-create directory structure, config files, and entry points.

### Verification depth
Shallow: one syntax check (tsc, JSON parse).
Deep: **layered checks** from syntax through runtime. Each check catches a different class of error. Domain-specific checks are the most valuable — they catch errors that generic linters miss (e.g. stub detection, contract coverage, antipattern grep, runtime smoke tests).

Every verify check should have a **corresponding fix recipe** in the fix agent prompt. If you can't describe how to fix it, the check is useless.

### Fix agent specificity
Shallow: "fix the errors."
Deep: fix prompt contains a **table of error patterns → fixes** specific to the domain. Common error codes, their causes, and exact resolution steps. An escape hatch for unfixable errors (delete cache and exit > random changes).

## Choosing Your Design

Questions to ask when designing:

1. **Is there a natural contract boundary?** (types, schema, outline, manifest) → If yes, separate spec from impl
2. **How many file groups are there?** → Each group that needs different expertise = potential agent boundary
3. **What can be verified deterministically?** → List every check. This drives your verify state.
4. **What needs to be scaffolded?** → Code state, not agent
5. **Does the user need to review intermediate output?** → Interactive checkpoint with ctx.interactive()
6. **Are there optional components?** → Branching events
7. **Is there a natural order?** → Linear states. If not → consider branching
