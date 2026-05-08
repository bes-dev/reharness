# Pipeline Design Guide

Reference for designing pi-fsm pipelines. Read this before designing a state graph.

## pi-fsm Capabilities

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

## Pipeline Topology Patterns

Choose the topology that fits the domain. Don't force every pipeline into the same shape.

### 1. Linear with verify/fix loop
The simplest and most common pattern. Good when work flows in one direction.
```
A → B → C → verify ↔ fix (max N) → done/error
```
Use when: steps are sequential, output of one feeds into the next.

### 2. Branching
Different paths based on input or intermediate results.
```
analyze → { HAS_TESTS: test_first, NO_TESTS: generate_tests } → implement → verify
```
Use when: the pipeline needs to handle different starting conditions.

### 3. Parallel decomposition (via separate states for independent work)
When two agents work on different files with no dependency.
```
scaffold → spec → { types → logic, types → ui } → verify
```
In pi-fsm this is modeled as sequential states but agents operate on non-overlapping files. True parallelism isn't built-in, but independence means order doesn't matter for correctness.

### 4. Iterative refinement
A loop that improves output over multiple passes, not just fixes errors.
```
draft → review → { GOOD: done, NEEDS_WORK: refine → review }
```
Use when: quality is subjective and needs multiple iterations. The review state can use deterministic heuristics (word count, coverage) or interactive sessions.

### 5. Multi-stage verify
Different verification at different pipeline stages, not just at the end.
```
spec → verify_spec → implement → verify_impl → deploy → verify_deploy → done
```
Use when: catching errors early saves expensive downstream work.

### 6. Interactive checkpoints
States where a human reviews and can modify artifacts before continuing.
```
research → outline → [INTERACTIVE: review_outline] → generate → verify → done
```
Uses `ctx.interactive()` — opens a tmux pane where user collaborates with agent. Pipeline blocks until session ends.

### 7. Conditional components
Not every run needs every state. Use events to skip optional states.
```
plan → scaffold → implement → { HAS_UI: build_ui, NO_UI: skip } → verify → done
```
Use when: the pipeline handles varied inputs (some apps need UI, some don't).

### 8. Model routing
Different agents get different models based on task complexity.
```
research (opus) → design (opus) → implement (sonnet) → verify → fix (haiku) → done
```
Use when: optimizing cost/quality tradeoff. Expensive models for creative/research work, cheap models for mechanical fixes. Models can come from user input via `ctx.config`.

## Design Principles

### Contract-first decomposition
When generating code or structured content, separate **specification** from **implementation**:
1. First agent produces the contract (types, interfaces, outline, schema, manifest)
2. Next agent(s) implement against the frozen contract
3. Verify checks that implementation matches contract

This gives clear artifact boundaries and typed verification between layers. But it's a principle, not a rule — some domains don't need contracts (e.g. single-file generation).

### Agent granularity
Split agents when they work on **different files** or need **different domain knowledge**. Don't split just for the sake of splitting.

Good split: `logic` agent (services, stores) + `ui` agent (components, screens) — different files, different expertise.
Bad split: `header` agent + `footer` agent — same file, same knowledge, artificial boundary.

A single agent that generates a 200-line HTML file is fine. Five agents each writing 40 lines of the same file is not.

### Scaffold as code
Project setup (create dirs, install deps, write config) should be a code state with `ctx.shell()` and `writeFileSync()`. Deterministic, fast, reproducible. Don't use an agent for what a shell script can do.

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
