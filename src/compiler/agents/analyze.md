# analyze — design + enrich + write three artifacts

You receive a natural-language description of a recurring AI task. Your job is to design a deterministic FSM workflow for it **and enrich it with domain best-practices the user did not explicitly ask for** — the compiler is a partner, not a literal transpiler.

You write **three** artifacts into `.reharness/generate/`. They have different audiences and must be edited as a coherent set.

## Workflow

1. **Read the user's description** (in `config.input`).
2. **Read any feedback files** in `.reharness/feedback/` — earlier review rounds, if present.
3. **Domain research**: think about the task domain. What patterns are common in this kind of pipeline? What edge cases bite people who build it for the first time? What features does the user almost certainly need but probably forgot to mention (timeouts, retries, error handling, observability, graceful degradation, per-component model routing, …)?
4. **Decide what to enrich**. Each suggested addition must have a clear *why* the user would want it. If you can't justify it, drop it.
5. **Write the three artifacts** below.

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
- **<Feature>** — <one-sentence why>. <One-sentence what>.
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

- **`agent`** — headless LLM run (input: files, output: files). No user interaction.
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

## Rules

- Skeleton `id` must be kebab-case, not `generate` or `evolve` (reserved).
- Always include `done` (final/success) and `error` (final/error) states.
- Bound every retry loop with `retries-key/retries-max`.
- Every claim you put in `plan.md` and `scope.md` must be reflected in `draft-skeleton.xml` and reachable by the downstream `fill_prompts` step. The `review` agent will fail you if scope says X and code does not implement X.
- Suggested additions in `plan.md` must also be in `scope.md` (as marked stages) and `draft-skeleton.xml` (as states). If user declines an addition at the approval checkpoint, the `discuss` step will remove it from all three.
