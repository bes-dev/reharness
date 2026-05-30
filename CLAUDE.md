# reharness — working agreement for AI agents

reharness is a **reasoning compiler**: it compiles a natural-language request into a runnable FSM-based AI workflow, via a self-hosted `/generate` meta-pipeline. Two layers, both finite-state machines:
- **runtime** (`src/runtime/`) — executes a compiled FSM (states = agent/code/… , typed transitions, guards).
- **compiler** (`src/compiler/`) — `/generate` turns a request → `skeleton.xml` → generated TS pipeline; `src/compiler/analysis/` statically validates it.

Both the runtime and the analyzer are **named restrictions of standard, well-studied models** — not ad-hoc. Before changing either, read the relevant theory doc and keep it true. The whole codebase was deliberately simplified to this form; **do not reintroduce removed machinery.**

## Theory (read before touching the matching code)

- **`.claude/theory/runtime.md`** — the execution model (deterministic hierarchical Moore-action transducer, run-to-completion). Read before editing `src/runtime/fsm.ts`.
- **`.claude/theory/analysis.md`** — the static analyzer (reachability + Kam–Ullman monotone dataflow) and the topology-derived data-flow / workspace model. Read before editing `src/compiler/analysis/*` or anything about how stages pass data.
- **`.claude/theory/pipeline.md`** — the `/generate` compiler pipeline and the design ethos. Read before editing `src/compiler/generate.ts` or the agent prompts in `src/compiler/agents/`.
- **`AGENTS.md`** — runtime API usage reference (how to write a pipeline/command/agent by hand): the State Context API, composite states, the `c.out`/`c.dir`/`c.dirs` workspace model. (For the *theory* behind the data flow, `.claude/theory/analysis.md`.)

## Hard invariants (non-negotiable — these encode hard-won corrections)

1. **Inter-stage data flow is DERIVED from the graph, never declared.** There is NO `produces`/`consumes`/`artifact`/`reads=`/`writes=`-on-agents/path syntax. A stage reads its ancestor producers' output dirs (computed by `visibleProducers`); the runtime injects them. Code writes to `c.out()`, reads via `c.dir(stage)` / `c.dirs(stage)`. **Never** add a data-declaration layer or hand-built paths.
2. **The analyzer stands on two engines in `analysis/framework.ts`** (`reachableFrom`, `solveMonotoneSets`). Every check is an *instance* (definite-assignment = forward-MUST; reachability; visibleProducers = may-reachability + cardinality). **Do not hand-roll new fixpoints** — add an instance.
3. **The runtime is a deterministic hierarchical Moore-action transducer with run-to-completion.** δ is total and **fails loud** (never silently stalls). `parallel` = fork-join (real OS-process parallelism for agent branches). Loops **require `max`** (guaranteed termination). **A parallel branch must not write shared `ctx.data`.**
4. **The compiler is LEAN: the LLM authors the minimal artifact** (graph + per-node behavioural `<contract>`); everything mechanical is a deterministic graph-pass. The human approves the **PRD** (intent), never the FSM graph. Correction is one `polish` agent editing only leaves; `redesign` is a rare last-resort.
5. **Decisions belong to FSM states (routing) or to an agent (judgment) — never to imperative runtime glue.** Don't parse/classify/gate between agent turns in the runtime.

## Design ethos

- **Simplify until it breaks determinism.** Lightweight & fast over feature-rich; this compiler must not burn tokens for an hour. We have repeatedly *removed* machinery (produces/consumes, the review loop, `<spec>`) when it added seams faster than checks.
- **One file, one responsibility. Minimal code — write only what's necessary. Remove dead code, don't comment it.** `noUnusedLocals` is on; the build is the dead-code guard.
- **Theory over heuristics.** If a check feels like "a rule that works on the cases I tried," reframe it as an instance of a standard analysis (see analysis.md).

## Build / verify

```
npm run build                                              # tsc + copy agent prompts to dist/ (also the dead-code gate)
node node_modules/typescript/lib/tsc.js --noEmit --noUnusedLocals --noUnusedParameters   # stricter dead-code check
```
`reharness` is `npm link`-ed → the global CLI runs `dist/` directly after a build. Examples under `examples/` are throwaway run artifacts (untracked).
