# Static analysis & data-flow model

`src/compiler/analysis/` validates a `skeleton.xml` and derives its data wiring. Every check is an instance of a **standard program-analysis** — not a bespoke graph walk. The two engines live in `framework.ts`; the FSM-specific checks are thin instances on top.

## The two engines (`analysis/framework.ts`)

1. **`reachableFrom(starts, next)`** — transitive closure (worklist BFS). The lattice is trivial (a reachable set).
2. **`solveMonotoneSets({nodes, preds, entry, gen, meet})`** — the **Kam–Ullman monotone data-flow framework**, specialised to the only lattice reharness needs (powerset of string keys), gen-only transfer `OUT = IN ∪ gen(n)`, iterated to a fixpoint.
   - `meet="intersect"` → **MUST** analysis (fact holds on EVERY path).
   - `meet="union"` → **MAY** analysis (fact holds on SOME path).
   - Monotone + finite-height lattice ⇒ converges.

**Add new checks as instances of these — never hand-roll another fixpoint or BFS.**

## The checks, by formal classification

| check | file | what it is |
|---|---|---|
| reachable-from-initial | `semantic.ts` | forward reachability (`reachableFrom([initial], succ)`) |
| can-reach-a-final (dead-end) | `semantic.ts` | **backward** reachability from finals over reverse edges (co-reachability) |
| definite assignment (ctx.data use-before-def) | `dataflow.ts` | **forward MUST** dataflow (`solveMonotoneSets`, meet=intersect, gen=`writesOf`): a `data.*` read must be written on every path reaching it |
| `visibleProducers` (data visibility) | `graph.ts` | **may-reachability** (ancestor producers) + structural **cardinality** classification |
| grammar / well-formedness | `lint.ts` | the format's "type system" (required fields, identifiers, ref validity, guard compile) |
| contract coverage | `semantic.ts` | every agent/code/interactive has a `<contract>` |
| `c.dir`/`c.dirs` stage-ref validity | `verify.ts` | a string-literal stage name read by the generated lib must be a real producer stage — the **workspace dual of `configFlowErrors`** (which checks every `c.config.X` is a declared input). Catches a hallucinated name (`judge_phase` for stage `judge`) that would make `c.dirs` return `[]` → a silent empty read |

`computeRoles` + `successors` (`graph.ts`) are the role-aware traversal (a parallel branch / loop step routes via its parent's join, not its own `<on>`) — the single source of "what does a state lead to" for all of the above.

## Data-flow / workspace model (how stages pass data)

Inter-stage data flow is **DERIVED from the topology, never declared.** Authors write no paths, no `produces`/`consumes`.

- **`visibleProducers(sk, N)`** = the producer stages whose output N may read = N's ancestor producers (a MAY relation; plus co-loop-step producers, since loop steps co-execute across iterations). Each is classified by **output cardinality** using the **instance-wise rule** (polyhedral / Feautrier — `enclosingScope` gives each state its enclosing-composite chain = its iteration space):
  - `single` — every enclosing composite of P also encloses N (P's instance is fixed by N's outer context) → one dir. Covers linear, and same-scope reads incl. loop-carried.
  - `list` — N has EXITED ≥1 enclosing composite of P → a COLLECTION over those axes: one dir per branch (exited parallel = **map**) and/or per iteration (exited loop = **scan / history**).
  One law for parallel and loop, at any nesting depth.
- **Runtime dirs key a stage by its full INSTANCE VECTOR**: `<runDir>/work/<stage>/<i0>/<i1>/…`, one index per enclosing composite (parallel branch index / loop iteration). Producer-write, recorded `data.branches[i].dir`, and consumer-read all derive from `(stage, instance vector)` → cannot drift. Accessors: `c.out()` (own instance), `c.dir(s)` (the single shared-scope instance; loop-carried-aware = latest existing ≤ current), `c.dirs(s)` (the collection over exited axes).
- Two **internal** channels: **`ctx.data`** (in-memory scalars; written by code-state `entry` actions only) and **per-stage workspace dirs** (files; agents + code). To use an agent's result in a guard, a `code` bridge reads its dir → sets `ctx.data`. (Under a `parallel`, each branch gets its OWN `ctx.data` copy — branch scalar writes are branch-local; cross-branch data flows only through the dirs, read by the join via `data.branches`.)
- **External targets** (the third channel, for the real world) — paths/endpoints the workflow *operates on* (the user's dotfiles dir, a target repo, a deploy host) are NOT inter-stage artifacts: they are declared as **`<inputs>`** and accessed via **`config.<name>`**. This is the only path namespace that may point outside the run dir; it keeps the workflow parameterised (a DevOps/in-place task reaches the filesystem) while the workspace stays derived. The workspace-escape lint enforces the split: a `config`-derived path is allowed; a HARDCODED `os.homedir()`/absolute literal is rejected (non-parameterised). The `configFlowErrors` check already forces every `config.X` read to be a declared input — so external targets are always declared, never ad-hoc.

All analyses + the data-flow model run **per skeleton** — one skeleton is one command. A `reharness/` may hold several commands; each is analyzed independently, and its generated agents/tools are namespaced under `<cmdId>` (see `pipeline.md`).

### Output-side need-to-know (render-once) — the dual

`visibleProducers` governs what flows INTO a stage (input need-to-know). The symmetric **output-side** property: a producer's content is **materialized in full exactly once**. A sink that aggregates many producers (a final report, an index) must REFERENCE — counts + an id/location index + cross-cutting synthesis — never a second full copy of content an upstream stage already wrote.

This needs **no new fixpoint** — the signal is derivable from the live `visibleProducers` engine: a producer read by ≥2 consumers (high fan-in) that each materialize it in full is duplicated output, the output dual of input need-to-know. It is a **candidate the authoring stage adjudicates** (a sink may legitimately read just one field), not an auto-rewrite — the principle is enforced where the LLM authors the artifact (`design`/`fill_prompts_lib`, per the LEAN invariant), and the empirical guard is the deliverable's **duplication ratio** (rendered ÷ unique content), a healthy pipeline ≈ 1. The theory was asymmetric — rigorous on input visibility, silent on output materialization; this closes that half. *(History: a final-report code-state re-rendered every finding's full body — already in its per-dimension dossier — plus embedded whole proposed files, blowing output ~4.5× with zero extra coverage. The cause was the missing principle, not a broken one; input isolation was intact.)*

### Why this shape (history — don't reintroduce the old layers)

We tried `artifact=`/`requires=` (path drift), then `produces`/`consumes` (declaration-vs-prose drift, parallel-boundary holes). Both *relocated* the drift seam. The realization: **a graph edge already IS the data contract** — so derive it, declare nothing. `visibleProducers` + flat dirs fixed the parallel-boundary bugs (a branch reaching pre-parallel data; the join reading per-branch outputs) generically.

## Genericness — generic for any topology via the instance vector

Correct & generic for: linear (incl. grand-ancestor skip), parallel (fan-out + fan-in = map), loop (incl. cross-iteration **history** = scan, and loop-carried reads), **nested composites at any depth** (the instance vector grows one axis per composite — nesting is allowed, not forbidden), switch/diamond, check-desugar. Remaining boundaries:
- **Conditional producers** (on alternate switch arms) are offered permissively — no "produced on every path" guarantee for files (only `ctx.data` has the MUST check). Intentional; files are read defensively.
- **`call` sub-pipeline outputs** are not modeled as producers. Rare; unaddressed.

This is the **polyhedral iteration-space model**: a stage executes once per point in its iteration space (its iteration vector = surrounding parallel/loop indices); an instance-wise read sees the producer instances on its shared-scope prefix, collected over the axes it has exited (Feautrier-style array dataflow). Loop history and nested fan-out fall out of one rule.

## References

FSM lint (reachability/deadlock/livelock); Kam–Ullman monotone framework (reaching definitions / live variables / definite assignment are instances). Our `parallel` data flow is a fork-join task-DAG dependency, not orthogonal-region dataflow.
