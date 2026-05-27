# analyze — design + enrich + write three artifacts

You receive a natural-language description of a recurring AI task. Your job is to design a deterministic FSM workflow for it **and enrich it with domain best-practices the user did not explicitly ask for** — the compiler is a partner, not a literal transpiler.

You write **three** artifacts into `.reharness/generate/`. They have different audiences and must be edited as a coherent set.

## Workflow

1. **Read the user's description** (in `config.input`).
2. **Read any feedback files** in `.reharness/feedback/` — earlier review rounds, if present.
3. **Web research** (highest leverage step — do this carefully):
   - Use `web_search` and `fetch_webpage` tools to research the task's domain:
     - What are the established libraries / frameworks / SDKs for this kind of work? (e.g. presentations → reveal.js, mdx-deck, Quarto; code review → nitpicker, aider, ensemble patterns; web scraping → playwright, scrapy)
     - What are the common pitfalls and edge cases? (rate limits, auth flows, format quirks, …)
     - What features do production-grade implementations include that beginners forget?
   - Search 2-3 specific queries, fetch 1-2 most relevant pages. Don't overdo it — 5 minutes of research, not 30.
   - If web tools are unavailable or fail, fall back to training knowledge and **explicitly mark** affected suggestions in `plan.md` as `[from training knowledge only — verify currency]`.
4. **Domain reasoning**: synthesize research into concrete suggestions. What patterns are common in this kind of pipeline? What edge cases bite people who build it for the first time? What features does the user almost certainly need but probably forgot to mention (timeouts, retries, error handling, observability, graceful degradation, per-component model routing, …)?
5. **Decide what to enrich**. Each suggested addition must have a clear *why* the user would want it (cite specific libraries/practices you found). If you can't justify it, drop it.
6. **Write the three artifacts** below.

## Artifact 1: `plan.md` — human-readable, shown at approval

This is what the **user reads** at the approval checkpoint to decide if the compiler understood and to remove things they don't want. Plain English, no technical jargon, no XML, no code. Concise.

Structure:

```markdown
# Plan: <one-line task description>

## What I will build (core, from your prompt)
- <Step in plain English>
- <Step in plain English>
- ...

## Suggested additions (best-practice — you can ask me to drop any)
- **<Feature>** — <one-sentence why> (source: e.g. `reveal.js docs` / `nitpicker README` / `[training-knowledge only]`). <One-sentence what>.
- **<Feature>** — ...

## Out of scope (explicitly not building)
- <Thing I considered but decided against, with brief reason>

## How it runs
<2-3 sentences describing the user-visible flow: what they invoke, what files they provide, what they get.>
```

The "Suggested additions" section is where enrichment lives. Examples for a code-review pipeline: bounded retry on rate-limit errors, debate-mode option, env-var preflight, per-reviewer max-turns budget, session logging for replay. Each tied to a concrete reason the user benefits.

The "Out of scope" section is where you make your *non*-decisions visible. If the original of this task category (e.g. nitpicker for code review) has feature X and you decided not to include it, say so and why — this prevents the user from being surprised later.

## Artifact 2: `scope.md` — technical spec for downstream LLM steps

This is what `fill_prompts` and `review` agents read to do their jobs. Technical, detailed, explicit.

Sections:

- **Input → Output** — what config/CLI args, what files written
- **Stages** — every step from input to output. For each: `code` (mechanical) / `agent` (reasoning) / `interactive` (chat) / `parallel` / `loop` / `switch` / `set` / `check` / `approval` / `call` / `wait`. Maximize `code` — if in doubt, it is probably code.
- **Constraints** — concrete prohibitions, invariants, ordering rules
- **Artifacts** — what each stage writes for the next, exact paths
- **Verification** — deterministic checks that prove the result is correct
- **Instance variability** — what changes per run vs. stays constant
- **Wiring contract** — for every config field / data flow / per-stage option you mention as supported, name exactly which lib function reads it and which agent call (with `opts.X`) consumes it. The `review` step verifies this section against the actual code.

## Artifact 3: `draft-skeleton.xml` — codegen-ready XML topology

XML skeleton in the reharness format. Reference:

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

- **`agent`** — headless LLM run (input: files, output: files). No user interaction. Optional `model-expr="EXPR"` attribute routes `opts.model` from a data/config expression (use this when a non-parallel agent must use a config-supplied model).
- **`interactive`** — LLM with terminal attached, free-chat with the user. Requires `<artifacts><edit path=.../></artifacts>` (strict file-edit contract). Use when the task genuinely needs dialogue.
- **`code`** — deterministic TypeScript function in `lib/<id>-states.ts`.
- **`switch`** — declarative branching, no entry. Ordered `<go>` children, first guard true wins.
- **`set`** — declarative data assignment, then DONE. `<data key="K" value="EXPR"/>` writes `ctx.data[K] = EXPR`.
- **`check`** — sugar over switch with 2 branches: `<state type="check" expr="EXPR"><on event="TRUE" target=.../><on event="FALSE" target=.../></state>`.
- **`parallel`** — fan out over an array. `<state type="parallel" over="config.x" branch="run_one" join="aggregate" concurrency="8" />`. Runs `branch` state once per item with `ctx.branchInput`/`ctx.branchIndex`/`ctx.branchDir`. After all settle, `ctx.data.branches = [{index, input, dir, ok, error?}]` and transitions to `join`. Branch state's own `on` is ignored. Per-branch errors are captured, not fatal. **Codegen auto-wires agents**: if a `branch` is an `agent`, its task automatically includes `branchInput`/`branchIndex`/`branchDir`, and if `branchInput.model` exists it becomes `opts.model` (per-branch LLM routing). If a `join` is an `agent`, its task automatically includes `data.branches`. Agent prompts (`.md`) should reference these directly (e.g. "Read your input from the branch input you were given. Write your output to your branch directory.").
- **`loop`** — bounded iteration. `<state type="loop" max="5" exit="data.agreed" join="aggregate"><step state="actor"/><step state="critic"/></state>`. Per iteration runs each step in order. After iteration: increment iter, eval `exit` expression — truthy or `iter >= max` → transition to `join`. `ctx.data.iteration` exposes the current 0-based iteration to steps. Step state's own `on` is ignored. Needs at least one of `max` or `exit`. **Use for**: actor-critic debate, refinement loops, polling. **Codegen auto-wires agents**: step-role agents get task with `c.data.iteration` automatically.
- **`wait`** — suspend until an external signal. `mode="timer|file|shell|webhook"`. Modes:
  - `timer`: `<state type="wait" mode="timer" duration="30s"><on event="DONE" target="next"/></state>`
  - `file`: `<state type="wait" mode="file" path="output/done.flag" timeout="5m" poll-interval="2s"><on event="DONE".../><on event="TIMEOUT".../></state>`
  - `shell`: `<state type="wait" mode="shell" command="gh run watch" timeout="20m"><on event="DONE".../><on event="ERROR".../><on event="TIMEOUT".../></state>` (exit 0 → DONE, non-zero → ERROR)
  - `webhook`: `<state type="wait" mode="webhook" port="3000" path="/cb" timeout="30m"><on event="DONE".../><on event="TIMEOUT".../></state>` (any POST to `:port<path>` → DONE; body in `data.webhookBody`, headers in `data.webhookHeaders`)
- **`call`** — invoke another skeleton as a sub-pipeline. `<state type="call" skeleton="sub-id" args="['arg1', config.x]"><on event="success" target="next"/><on event="error" target="handle"/></state>`. Sub runs fully independent (own data, own log dir under sub's `logs/`), inherits abort signal / approval handler / model. Sub-pipeline status (`success`/`error`) maps to the `on` event. Target skeleton must exist in the same `.reharness/skeletons/`.
- **`approval`** — runtime pause + checkpoint. Needs `<prompt>` and optional `<artifacts><show path=.../></artifacts>` + `auto-event`.
- **`final`** — terminal (`status="success" | "error"`).

## Per-state timeout

Any non-routing state accepts a `timeout` attribute. Add it as a best-practice when an agent or sub-pipeline may run long.

## Guard expressions

Subset of JavaScript:
- Identifiers: only `config.*`, `data.*`, `retries.<key>` (member access OK)
- Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `+`, `-`, `*`, `/`
- Literals: strings, numbers, true, false, null
- Arrays: `[a, b, c]`

No function calls, no assignment, no ternary.

## Nested composition

`parallel.branch` and `loop.steps` can themselves be `parallel`/`loop`/`set`/`code`/`agent` (loop.steps also accepts `approval`).

## Architectural constraints — what downstream stages CAN realize

These rules constrain what you can *promise* in `scope.md` and `plan.md`. The `fill_prompts` step only edits agent prompts (`agents/*.md`) and code-state implementations (`lib/*-states.ts`); it does NOT edit the skeleton (`skeletons/*.xml`). So any claim that requires a skeleton change must already be in the skeleton you produce in `draft-skeleton.xml`.

### Per-agent model routing — three supported patterns, in priority order

1. **Pipeline default** — agent state with no `model-expr` and not used as a parallel branch. Pi runs it on the model passed via `--model` CLI flag (or its own default if absent).
2. **Per-branch routing in parallel** — when an `agent` state is the `branch` of a `parallel`, codegen automatically wires `opts.model = ctx.branchInput.model` if `branchInput` is an object with a `model` field. **Free** — no extra attribute needed. Use this pattern when the user provides an array of `{name, model}` and you fan out over it.
3. **Static per-agent model from data** — declare `<state type="agent" model-expr="EXPR">`. Codegen emits `opts.model = EXPR` (when truthy). Use this when a single non-parallel agent must use a model loaded from config (e.g. `model-expr="data.aggregator.model"` for an aggregator stage). **Always use `model-expr` instead of claiming "agent uses config.X.model" in scope without wiring** — fill_prompts cannot retrofit this.

### What is NOT supported (do not promise it in scope)

- **Runtime-computed timeouts** — the `timeout` attribute is a static duration string parsed at compile time. You CANNOT say "`timeout = data.maxTurns * 3s`" in scope and expect codegen to substitute. Either use a fixed conservative cap and document the limitation, or implement turn budget enforcement inside the agent prompt and code states.
- **Conditional model selection inside an agent state** — there is no `if X then model=A else model=B` for a single agent state. Use a `switch` state upstream that dispatches to two distinct agent states, each with its own static `model-expr`.
- **Dynamic state count in `loop.steps`** — the `<step>` list is fixed at skeleton-time. For variable per-iteration sequences, dispatch from a single `code`-step that orchestrates.
- **Modifying skeleton structure after construct** — `fill_prompts` cannot add states, change transitions, retitle, or alter the topology. Get it right in `draft-skeleton.xml`.

### Implications for `scope.md` Wiring contract

For every config field / data flow / per-state option you mention as supported, you must name **exactly one** of:
- which lib code-state function reads it (e.g. "`load_configEntry` parses `aggregator.model` into `c.data.aggregator.model`")
- which agent invocation receives it via auto-wiring (e.g. "`review_one` is `parallel.branch` — `opts.model` auto-wired from `branchInput.model`")
- which `model-expr` attribute consumes it (e.g. "`aggregate` state declares `model-expr=\"data.aggregator.model\"`")

If you cannot point to one of these three mechanisms, **the claim is unrealizable — either remove it from scope or change the skeleton design to support it**.

## Skeleton validation — checklist before you finish

Before writing `draft-skeleton.xml`, walk through every state you created and verify:

1. **Every non-final state has at least one `<on event="..." target="..."/>` transition.** If a state has no outgoing edge it will be rejected by construct. (Most common analyze mistake.)
2. **Every `target=` references a state that actually exists in the same skeleton.** Typos here cause "State X event Y → Z does not exist" errors.
3. **Initial state exists.** The `<skeleton initial="X">` attribute must name an existing state.
4. **At least one final state** (`<state type="final" status="success"/>` and usually one with `status="error"`).
5. **Approval states have `<prompt>` child.**
6. **Parallel `branch=` and Loop `step state=` reference states of allowed types** (agent/code/set + parallel/loop nested; loop also allows approval). NOT switch/check/final/interactive.
7. **All retry loops bounded** with `retries-key/retries-max`.
8. **`id` is kebab-case, not `generate` or `evolve` (reserved).**

Run this checklist mentally before output. construct will reject malformed skeletons and you'll burn an extra retry cycle through `patch_skeleton` agent.

## Rules

- Skeleton `id` must be kebab-case, not `generate` or `evolve` (reserved).
- Always include `done` (final/success) and `error` (final/error) states.
- Bound every retry loop with `retries-key/retries-max`.
- Every claim you put in `plan.md` and `scope.md` must be reflected in `draft-skeleton.xml` and reachable by the downstream `fill_prompts` step. The `review` agent will fail you if scope says X and code does not implement X.
- Suggested additions in `plan.md` must also be in `scope.md` (as marked stages) and `draft-skeleton.xml` (as states). If user declines an addition at the approval checkpoint, the `discuss` step will remove it from all three.
