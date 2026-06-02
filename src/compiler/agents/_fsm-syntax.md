# reharness FSM syntax reference

Shared reference for every agent that builds or edits a skeleton. Defines the state types, routing,
guard grammar, model routing, and the hard naming/encoding rules. This is the single source of truth
for the DSL — the agent-specific prompt above tells you *what* to do; this tells you *how to write it*.

## State types

- **`agent`** — headless LLM run. Optional `model-expr="EXPR"` routes per-state model from a data/config expression. Optional `<harness>` child tunes its per-leaf environment: `<harness model="..." thinking="off|minimal|low|medium|high|xhigh" context-files="off" />` (all attrs optional; absent ⇒ Pi defaults). `model-expr` > `<harness model>` > pipeline default. Optional `<tools><tool name=".." effect=".."><spec>..</spec></tool></tools>` — synthesized deterministic tools the agent calls for mechanical sub-ops (fill turns each `<spec>` into an `execute()`); most agents need none.
- **`interactive`** — LLM with terminal attached. Requires `<artifacts><edit path=.../></artifacts>`.
- **`code`** — deterministic TypeScript function in `lib/<id>-states.ts`. Must NOT call `ctx.agent`.
- **`switch`** — declarative branching. Ordered `<go>` children, first guard true wins.
- **`set`** — declarative data assignment. `<data key="K" value="EXPR"/>`.
- **`check`** — sugar over switch: `<state type="check" expr="EXPR"><on event="TRUE" target=.../><on event="FALSE" target=.../></state>`.
- **`parallel`** — fan out over an array. `<state type="parallel" over="config.x" branch="run_one" concurrency="8"><on event="DONE" target="aggregate"/></state>`. Runs `branch` once per item; after all settle, `data.branches = [{index, input, dir, ok, error?}]` and control goes to the `<on event="DONE">` target. Codegen auto-wires `branchInput`/`branchIndex`/`branchDir`; if `branchInput.model` exists it becomes `opts.model`.
- **`loop`** — bounded iteration. `<state type="loop" max="5" exit="data.agreed"><step state="actor"/><step state="critic"/><on event="DONE" target="synth"/></state>`. Runs each `<step>` per iteration; `data.iteration` is the 0-based counter. **`max` is REQUIRED** (a hard bound that guarantees termination); `exit` is an optional early-out. After the loop ends, control goes to the `<on event="DONE">` target.
- **`wait`** — suspend until external signal. `mode="timer|file|shell|webhook"`.
- **`call`** — invoke another skeleton. `<state type="call" skeleton="sub-id" args="['arg1', config.x]">...</state>`.
- **`approval`** — runtime pause. Needs `<prompt>` + optional `<artifacts><show path=.../></artifacts>` + `auto-event`.
- **`final`** — terminal. `status="success" | "error"`.

## Routing — uniform across all states

Every state names its next state with `<on event="..." target="..."/>`. There is **no `join=`/`next=` attribute**.

- **parallel / loop** advance via `<on event="DONE" target="X"/>` exactly like any other state. The states in `branch=` / `<step>` are the *body*: they run, then control returns to the parallel/loop, which advances to the `DONE` target. A body state's own `<on>` is **ignored by the runtime** — you may omit it. Optionally add `<on event="TIMEOUT" target="..."/>`.
- **code** states implicitly route `ERROR → error` if you don't declare `<on event="ERROR">`.
- Guarded transitions: `<on event="FAIL"><go target="retry" retries-key="k" retries-max="2"/><go target="error"/></on>` (first matching `<go>` wins).

## `<inputs>` — the CLI interface (the ONE declaration)

The pipeline's command-line inputs are EXTERNAL (from the user, not the graph) so they can't be derived — declare them once in `<inputs>`, right after `<usage>`. codegen generates the argument parser from this; a static check enforces that every `config.X` the pipeline reads is declared here.

```xml
<inputs>
  <arg name="repo" positional="true" default="."/>          <!-- positional; config.repo -->
  <arg name="models" type="list" required="true"/>          <!-- --models a,b,c → config.models = ["a","b","c"] -->
  <arg name="rounds" type="number" default="3"/>            <!-- --rounds → config.rounds (number) -->
  <arg name="fix" type="bool"/>                             <!-- --fix (presence) → config.fix -->
</inputs>
```

- `<arg name="X">` → `config.X`. Default flag is `--X` (kebab-cased); `positional="true"` reads a positional arg; `flag="--xyz"` overrides.
- `type`: `string` (default) | `list` (comma-split) | `number` | `bool` (flag presence). `default=`, `required="true"`.
- **`config.target`** (working dir) and **`config.input`** (positional args joined) are always provided — never declare them.
- Read in code as `c.config.X`, in guards/`over`/`exit`/`model-expr` as `config.X`. **Every `config.X` you read must be declared** (deterministic check).

## Data flow — derived from the graph, never declared

Data moves two ways. **You declare nothing about it** — no paths, no `produces`/`consumes`, no `run_dir`/`{branchDir}`. The compiler owns it.

- **`ctx.data`** — in-memory scalar values. **Only `code` and `set` states write it** (`set` via `<data>`, `code` via `c.data.x = …`). Guards/`over`/`exit`/`model-expr` read it. Agents CANNOT touch `ctx.data`.
- **Per-stage workspace (files)** — every stage has its own output directory. At runtime the compiler derives, from the graph, **which upstream producers each stage can read**, and hands them over:
  - **write your own outputs** into `c.out()` (code) or "your output directory" (agents — injected into the task);
  - **read a single upstream producer** (a top-level or loop-step stage) from **`c.dir('<stage>')`** (code) / its injected dir (agents);
  - **read a parallel-branch producer** — it has ONE dir per branch item — via **`c.dirs('<stage>')`** (code) / the injected per-branch dir list (agents).

  "Who can read whom" comes from the graph edges (any ancestor producer is visible); a parallel branch's output is automatically seen as a per-branch list by anything downstream of its join. You declare none of it — no paths, no `produces`/`consumes` — so it **cannot drift**.

Mechanism (why): an agent runs in a separate process with only its task string — files only, never `ctx.data`. A `code` state runs in-process — it owns `ctx.data` and reads upstream files via `c.dir`/`c.dirs`.

- **To use an agent's result in a guard/expr:** add a small `code` state after it that reads the agent's output (`c.dir('<agent>')`, or `c.dirs(...)` if the agent was a parallel branch) and writes the value into `ctx.data` (the bridge). The guard then reads `data.x`.

```xml
<state name="classify" type="agent"> ... </state>           <!-- writes into its own output dir -->
<state name="review"   type="parallel" branch="reviewer" over="data.models"><on event="DONE" target="gate"/></state>
<state name="gate"     type="code"> ... </state>            <!-- reads c.dirs('reviewer') (one dir per model), sets c.data.has_blocking -->
<switch ...><go guard="expr:data.has_blocking" target="block"/><go target="advise"/></switch>
```

## Per-state timeout

Any non-routing state accepts `timeout="30s"`. Add it when an agent or sub-pipeline may run long.

## Guard expressions

Subset of JS: identifiers `config.*`, `data.*`, `retries.<key>`; operators `== != < <= > >= && || ! + - * /`; literals (strings/numbers/true/false/null); arrays `[a,b,c]`. No function calls, no assignment, no ternary.

## Per-agent model routing — three supported patterns

1. **Pipeline default** — agent with no `model-expr`, not a parallel branch.
2. **Per-branch routing** — agent as a `parallel` branch; codegen auto-wires `opts.model = branchInput.model`. Free.
3. **Static from data** — `<state type="agent" model-expr="data.aggregator.model">`. Use when a non-parallel agent reads a model from config.

## Hard rules (enforced by `construct`)

- **State and event names must be valid identifiers** — letters/digits/underscore, **NO hyphens** (they become TypeScript identifiers; `ingest-diff` breaks codegen — use `ingest_diff`). The `id` attribute alone may be kebab-case.
- **Every non-final state needs ≥1 `<on>` transition**; every `target=` must reference an existing state; `initial=` must exist; at least one `final` state.
- **Every state reachable** from `initial`, and **able to reach a final** (no orphans / unbounded cycles).
- **Parallel `branch=` / loop `step=` may be** agent/code/set/parallel/loop (nesting is fine — every instance is addressed by its full iteration vector); loop `step=` also allows approval. Neither allows switch/check/final/interactive.
- **No data-flow attributes exist** — `produces`/`consumes`/`reads`/`writes`/`artifact`/paths are NOT part of the syntax. Inter-stage data is derived from the graph (per-stage workspace); the contract prose describes it in plain words.
- **`id` is kebab-case, not `generate`/`evolve`** (reserved).
- Wrap `<contract>` bodies in `<![CDATA[ ... ]]>`.
