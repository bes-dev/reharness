# replan — repair the FSM topology when a runtime failure can't be fixed in a leaf

A run FAILED, and the `heal` step determined the root cause is **not** in a leaf — it's in the **spec/topology**:
the skeleton's graph or a node's `<contract>` is wrong, a stage is missing, the wiring/routing is off, or a stage
has the wrong type. You repair the **skeleton** so the next run succeeds. This is reflective topology repair —
fix HOW the pipeline is realized, never WHAT it is for.

## Inputs (in your task)

- the failing stage and the failure reason;
- `reharness/.cache/evolve/needs-redesign.md` — the one-line change `heal` said is needed;
- `reharness/.cache/scratch/_compiled.md` — the whole pipeline in one view (graph + contracts + code), if present;
- the failed run dir — `work/<stage>/` shows what actually happened.

## You may edit ONLY

**`reharness/skeletons/<id>.xml`** — the single source of truth: the graph (states / transitions / wiring) and
each node's `<contract>` (CDATA). Inter-stage data flow is **derived from the graph** — you never wire it by
hand; if a guard needs an agent's result, add a `code` bridge state that reads the agent's output dir and sets
`ctx.data`.

## How to repair (minimal topology change at the root)

Pick the smallest structural fix that removes the failure cause, e.g.:
- **missing stage** → add it (a pre-flight check, a normalization/chunking step, a retry/dedup stage, an
  error-handling path/terminal that wasn't there);
- **impossible contract** → split a stage into two, or correct the contract so a single node can fulfil it;
- **wrong wiring** → fix a transition target / guard, or add the missing error transition;
- **wrong state type** → change `code`↔`agent` where judgement vs mechanics was misjudged;
- **missing bridge** → add a `code` state between an agent and a guard that needs its result.

Keep every node's `<contract>` truthful about what that node does — the contract is the spec the code is
generated from. New states get a `<contract>`; the compiler will generate and fill their code after you.

## After you exit

The compiler re-runs `construct` (regenerate codegen; existing filled code/prompts are PRESERVED, only new
states get stubs) → `fill` (fill the new stubs) → `verify` → re-run the command to confirm the fix. So make the
skeleton correct and leave the code to the compiler.

## Rules

- Edit ONLY `reharness/skeletons/<id>.xml`. Do not touch lib, agent prompts, or commands (regenerated).
- Minimal, root-cause topology change — do not rewrite a working pipeline.
- Stay faithful to the pipeline's purpose; change realization, not intent. The DSL reference is appended below.
