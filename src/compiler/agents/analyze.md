# analyze — design a reharness workflow from a description

You receive a natural-language description of a recurring AI task. Your job is to design a deterministic FSM workflow for it and produce two artifacts.

## Output files (write into `.reharness/generate/`)

1. **`scope.md`** — structured scope document. Sections:
   - **Input → Output** — what the user provides and what the result is
   - **Stages** — every step from input to output. For each: `code` (mechanical: read/write/parse/validate) or `agent` (needs reasoning). Maximize `code` — if in doubt, it is probably code.
   - **Constraints** — concrete prohibitions and invariants
   - **Artifacts** — what each stage writes for the next
   - **Verification** — deterministic checks that prove the result is correct
   - **Instance variability** — what changes per run vs. stays constant

2. **`draft-skeleton.xml`** — XML skeleton in the reharness format. Reference:

```xml
<skeleton id="my-cmd" initial="first" format-version="0.1">
  <description>...</description>
  <usage>&lt;args...&gt;</usage>
  <state name="first" type="agent"><on event="DONE" target="check" /></state>
  <state name="check" type="code">
    <on event="PASS" target="done" />
    <on event="FAIL"><go target="first" retries-key="check" retries-max="2" /><go target="error" /></on>
  </state>
  <state name="done" type="final" status="success" />
  <state name="error" type="final" status="error" />
</skeleton>
```

## State types

- **`agent`** — headless LLM run (input: files, output: files). No user interaction.
- **`interactive`** — LLM with terminal attached, free-chat with the user. Requires `<artifacts><edit path=.../></artifacts>` (strict file-edit contract). Use when the task genuinely needs dialogue.
- **`code`** — deterministic TypeScript function in `lib/<id>-states.ts`.
- **`switch`** — declarative branching, no entry. Ordered `<go>` children, first guard true wins.
- **`set`** — declarative data assignment, then DONE. `<data key="K" value="EXPR"/>` writes `ctx.data[K] = EXPR`.
- **`check`** — sugar over switch with 2 branches: `<state type="check" expr="EXPR"><on event="TRUE" target=.../><on event="FALSE" target=.../></state>`.
- **`parallel`** — fan out over an array. `<state type="parallel" over="config.x" branch="run_one" join="aggregate" concurrency="8" />`. Runs `branch` state once per item with `ctx.branchInput`/`ctx.branchIndex`/`ctx.branchDir`. After all settle, `ctx.data.branches = [{index, input, dir, ok, error?}]` and transitions to `join`. Branch state's own `on` is ignored. Per-branch errors are captured, not fatal. **Codegen auto-wires agents**: if a `branch` is an `agent`, its task automatically includes `branchInput`/`branchIndex`/`branchDir`, and if `branchInput.model` exists it becomes `opts.model` (per-branch LLM routing). If a `join` is an `agent`, its task automatically includes `data.branches`. Agent prompts (`.md`) should reference these directly (e.g. "Read your input from the branch input you were given. Write your output to your branch directory.").
- **`loop`** — bounded iteration. `<state type="loop" max="5" exit="data.agreed" join="aggregate"><step state="actor"/><step state="critic"/></state>`. Per iteration runs each step in order. After iteration: increment iter, eval `exit` expression — truthy or `iter >= max` → transition to `join`. `ctx.data.iteration` exposes the current 0-based iteration to steps. Step state's own `on` is ignored. Needs at least one of `max` or `exit`. **Use for**: actor-critic debate, refinement loops, polling. **Codegen auto-wires agents**: step-role agents get task with `c.data.iteration` automatically.

## Nested composition

`parallel.branch` and `loop.steps` can themselves be `parallel` or `loop` states — they are not limited to `agent`/`code`. Allowed types:

| Slot | Allowed types |
|---|---|
| `parallel.branch` | agent, code, set, parallel, loop |
| `loop.steps`      | agent, code, set, approval, parallel, loop |

Examples:
- **`parallel`-of-`loop`** — multi-debate ensemble: N independent actor-critic sessions run in parallel, aggregator synthesizes.
- **`loop`-of-`parallel`** — iterative refinement with N parallel evaluators each round, exit when consensus.
- **`parallel`-of-`parallel`** — hierarchical fan-out (e.g. parallel over modules, each module fans out over files).

Branch/step state's own `on` transitions are still ignored when invoked via `parallel`/`loop`. Approval inside `parallel.branch` is forbidden (terminal-stdin contention); inside `loop.step` it is allowed (sequential execution).
- **`approval`** — runtime pause + checkpoint. Needs `<prompt>` and optional `<artifacts><show path=.../></artifacts>` + `auto-event`.
- **`call`** — invoke another skeleton as a sub-pipeline. `<state type="call" skeleton="sub-id" args="['arg1', config.x]"><on event="success" target="next"/><on event="error" target="handle"/></state>`. Sub runs fully independent (own data, own log dir under sub's `logs/`), inherits abort signal / approval handler / model. Sub-pipeline status (`success`/`error`) maps to the `on` event. Use for **reuse** (shared sub-flows), **encapsulation** (large pipelines split), and **meta-circular calls**. Target skeleton must exist in the same `.reharness/skeletons/`.
- **`final`** — terminal (`status="success" | "error"`).

## Guard expressions (in `<go guard="...">`, `<state type="check" expr="...">`, `<data value="...">`)

Subset of JavaScript:
- Identifiers: only `config.*`, `data.*`, `retries.<key>` (member access OK: `config.target`, `data.user.name`)
- Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`
- Literals: `'string'`, `42`, `true`, `false`, `null`
- Grouping: `(...)`

No function calls, no assignment, no ternary. If you need complex logic — use a `code` state.

## Examples

```xml
<!-- Declarative routing -->
<state name="route" type="switch">
  <go target="mobile_flow" guard="config.target == 'mobile'" />
  <go target="web_flow"    guard="config.target == 'web'" />
  <go target="error" />
</state>

<!-- Bounded loop via data + check -->
<state name="iterate" type="code">
  <on event="DONE" target="check_done" />
</state>
<state name="check_done" type="check" expr="data.count < 10">
  <on event="TRUE"  target="iterate" />
  <on event="FALSE" target="finish" />
</state>

<!-- Init data before branching -->
<state name="init" type="set">
  <data key="phase" value="'analysis'" />
  <data key="count" value="0" />
  <on event="DONE" target="route" />
</state>

<!-- Bounded retry (special-case guard, auto-increments counter) -->
<on event="FAIL">
  <go target="retry" retries-key="K" retries-max="3" />
  <go target="error" />
</on>

<!-- Parallel fan-out (multi-model code review pattern) -->
<state name="review_all" type="parallel"
       over="config.reviewers" branch="review_one" join="aggregate" concurrency="8" />

<state name="review_one" type="agent">
  <!-- prompt should reference ctx.branchInput (the reviewer config item),
       and write its result to ctx.branchDir/output.md -->
  <on event="DONE" target="aggregate" />  <!-- this transition is ignored when called as a branch -->
</state>

<state name="aggregate" type="agent">
  <!-- reads ctx.data.branches = [{index, input, dir, ok, error?}, ...]
       reads each branch's output.md from disk, synthesizes a final verdict -->
  <on event="DONE" target="done" />
</state>

<!-- Actor-critic debate with bounded rounds + early exit -->
<state name="init" type="set">
  <data key="agreed" value="false" />
  <on event="DONE" target="rounds" />
</state>

<state name="rounds" type="loop" max="5" exit="data.agreed" join="final_synthesis">
  <step state="actor" />
  <step state="critic" />
  <step state="check_agree" />  <!-- code state: reads critic's output, sets data.agreed if AGREE -->
</state>

<state name="actor"  type="agent"><on event="DONE" target="critic" /></state>
<state name="critic" type="agent"><on event="DONE" target="check_agree" /></state>
<state name="check_agree" type="code"><on event="DONE" target="rounds" /></state>
<state name="final_synthesis" type="agent"><on event="DONE" target="done" /></state>
```

## Inputs you get

- `config.input` — the user's description
- If prior revisions exist: read all files in `.reharness/feedback/` and address every point.

## Rules

- Skeleton `id` must be a kebab-case identifier (not `generate`, not `evolve` — reserved).
- Every code state needs deterministic logic the runtime can call.
- Every agent state must have a clear purpose; collapse "thin" agent states into code states.
- Always include a `done` (final/success) and an `error` (final/error) state.
- Bound every retry loop with `retries-key=... retries-max=N` guards.
