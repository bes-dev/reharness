# The `/generate` compiler pipeline

`src/compiler/generate.ts` is itself a reharness FSM (self-hosted) that compiles a request into a runnable pipeline. Its agent prompts live in `src/compiler/agents/`.

## Flow

```
maybe_research → research? → prd → [maybe_approve_prd → review_prd: APPROVAL] → design
   → construct → fill_prompts → check_dataflow → polish → verify → done
                                                    │ escalate → redesign (rare) ─┘
                                          verify FAIL → fix_verify (≤2) → verify ─┘
```

LLM stages in the happy path: **prd → design → fill → polish** (+ optional research). The graph-passes
(construct/codegen, check_dataflow, verify) are **deterministic — no LLM**; `verify` itself never calls an LLM,
but a verify *failure* routes to a bounded `fix_verify` (a `patch_node` LLM editing only the states lib) and
re-verifies (≤2 rounds). `maybe_approve_prd` is a switch that skips the human gate under `--auto-approve`.

| stage | kind | role |
|---|---|---|
| `research` | LLM (opt) | gather domain context → `research-findings.md` |
| `prd` | LLM | distil a **human-readable PRD** (goal/behaviour/acceptance/scope) from request + research |
| `review_prd` | approval | **the ONLY human gate** — approve the PRD (intent), never the FSM graph. Revise → `discuss_prd` |
| `design` | LLM | one pass: topology **graph + per-node behavioural `<contract>`** that implements the PRD. Self-validates in-session (validateSkeleton + contract coverage) via the RPC re-prompt loop |
| `construct` | code | validate, copy to `skeletons/`, codegen → `commands/` + `lib/` stubs + `agents/` stubs |
| `fill_prompts` | LLM (md‖lib) | fill agent prompt stubs + code-state implementations (incremental — only new stubs) |
| `check_dataflow` | code | deterministic prep: extract code ctx.data I/O, run definite-assignment, write report for polish |
| `polish` | LLM | **one** agent: review the whole pipeline vs the PRD and fix what's worth fixing — editing ONLY leaves (`agents/*.md`, `lib/*.ts`). Bounded by prompt + hard timeout. Topology problem → writes `escalate.md` |
| `verify` | code | tsc compile + structural checks (the objective backstop) |
| `fix_verify` | LLM | bounded repair on a `verify` failure (`patch_node`, edits only `lib/*.ts`) → re-verify, ≤2 rounds |
| `redesign` | LLM | **rare last-resort**: only when polish escalates a topology change it can't make in leaves |

## Three fronts converge on the PRD (`compile`, `amend`, `compile --from-session`)

> User verbs are `compile` (was `generate`) and `amend` (was `improve`); internals stay `generate.ts` / `buildGeneratePipeline` / `reharness/.cache/scratch/`.

The PRD is the **unification point** of input sources (see the design ethos): different front-ends produce a PRD, and everything from `review_prd` onward is shared. `buildGeneratePipeline` hosts all three via a `start` switch (on `config.session` / `config.amend`):

- **compile** (description): `start → maybe_research → research → maybe_distill → prd → review_prd → design → construct → …`
- **amend** (`amend <request>`): `start → load_amend → amend_prd → review_prd → amend_design → construct → …`
- **session** (`compile --from-session <path>`): `start → load_session → [condense] → maybe_research → research → maybe_distill → distill → review_prd → design → construct → …`

Both grounding fronts converge on a single `maybe_research → research → maybe_distill` segment: one evidence-adaptive `research` agent grounds the domain into `skills/`, then `maybe_distill` routes the grounded result to `distill` (session) or `prd` (request). `--fast` skips `research` on either front.

### Session front: compile from a demonstration (PBD + EBG)

A recorded session is a **demonstration** — a task done once. Compiling it into a reusable pipeline is **programming by demonstration**: generalise the single example into a parameterised program. The generalisation step is **explanation-based** (EBG) — explain *why* the trajectory achieved the goal, keep the weakest preconditions, drop everything specific to that run (the concrete repo/path/query become parameters; dead-ends and exploration are discarded). This is the *static, N=1, whole-pipeline* sibling of `evolve`'s dynamic, sub-routine amortization (same EBL family; see `evolve.md`). Four properties make it work:

- **The trace is grounded first, by the SAME research agent as the request front.** `load_session`/`condense` route into `maybe_research → research` before `distill`. There is one evidence-adaptive `research` agent (not a session-specific twin): it grounds from whatever evidence is present — here the trace's OBSERVED ground truth (the real call/auth/response), and the web for any exotic tool the trace shows but the model can't reconstruct (provenance is not in the log) — and records a reducibility verdict (reduces-to-code → discard the tool / non-reducible → human must provision). Because it is one agent, when several sources are present (e.g. a trace **and** a harness) it corroborates and reconciles them, preferring observed > written > web > memory. Without this, the demonstration's operational detail survived only insofar as `distill` echoed it into the PRD — the same ungrounded gap that grounding closed for the request front.
- **Format-agnostic by construction.** The session is read **raw** (`generate/session.md`) — JSONL, JSON export, markdown transcript, pasted chat, all the same. The **LLM is the universal parser**; there are NO per-format adapters and NO canonical session schema (no vendor lock to any agent's log format). The runner only concatenates a file/dir into `session.md`; the `distill` agent reads it. (Contrast Hermes: distils into free-floating `SKILL.md` prose, ingested from its own `SessionDB`.)
- **Large sessions are condensed first.** `load_session` routes a session over the per-pass char budget into `condense` — a map (one `condense_chunk` agent per slice → a trajectory digest) / reduce (`merge_digest` concatenates) — so `distill` always reads something that fits.
- **The human still approves the PRD.** `distill` writes the *generalised intent* to `prd.md`; `review_prd` gates it exactly as for the other fronts. A misread of the demonstration is caught at the same cheap checkpoint — the session front buys no special trust.

`load_amend` seeds `draft-skeleton.xml` with the **current** skeleton and stashes the PRD to `prd-prev.md`; `amend_prd` folds the request into the PRD (a `## Amendment` note + the approval gate make the human approve the *intent delta*); `amend_design` applies a **minimal skeleton delta**. The shared tail does the rest for free: `construct` preserves filled leaves and stubs only new states, `fill_prompts` fills only those, and `polish` reconciles any existing leaf whose contract the amendment changed. A feature request is an **intent change** — so it goes through PRD-approval (generate's lane), NOT autonomous `evolve` (which is trace-driven and changes the realization of the *same* intent). Large pivots → a fresh `generate`.

**Multi-command.** One `reharness/` is a workspace of several commands (Bazel/Cargo targets; Rust private-by-default modules). Each command's generated agents and synthesized tools are namespaced per `<cmdId>` (`agents/<cmdId>/<name>/`, `tools/<cmdId>/<leaf>/`); the PRD archive lives at the bundle root (`prds/<cmdId>.md`), and the shared compiler scratch (`prd.md`, `draft-skeleton.xml`, `_compiled.md`) lives under the gitignored `.cache/scratch/`. `compile` always builds a new target; `amend [<cmd>]` / `evolve [<cmd>]` select one (default = the sole command). `compile` reads the existing commands' skeletons/libs to coordinate (siblings-awareness). Building/amending B must not disturb A — `enhance` is scoped to the just-compiled command.

## Why it's shaped this way (the principles — keep them)

- **PRD-first.** The human validates *intent* (cheap prose); the compiler owns *realization* (the graph, which is too semantically hard for a human to review). Catches "built the wrong thing" at the cheapest point.
- **Minimal LLM artifact.** The LLM authors only the irreducibly-creative thing (graph + behavioural intent). Data wiring, paths, codegen, validation = deterministic graph-passes. The LLM never writes `produces`/`consumes`/paths (see `analysis.md`).
- **One lightweight `polish`, not a review→fix→re-review loop.** Empirically the reviewer never says "rewrite everything"; fixes are local. polish reviews+fixes in ONE hot context, editing only leaf artifacts; `verify` (deterministic) is the backstop. This replaced an expensive multi-round loop that re-ran the compiler per fix.
- **Decisions belong to states or the agent, never runtime glue.** polish *itself* decides what to fix; the FSM routes on its outcome. The runtime never parses/gates between turns.
- **In-session deterministic validation.** `design`/`redesign` run under RPC: after each turn the runtime re-prompts with `validateSkeleton` errors until clean — the agent self-corrects in its hot context, no fresh patch session.

## Editing the agent prompts (`src/compiler/agents/`)

- Keep them consistent with the workspace data model (`c.out`/`c.dir`/`c.dirs`; no `produces`/`consumes`/paths) — see `analysis.md`.
- `_fsm-syntax.md` is the shared DSL reference appended (via `{ append: "_fsm-syntax" }`) to the skeleton-authoring stages: `design`, `amend_design`, `redesign`, `polish`, and evolve's `replan`. The format authority is `_fsm-syntax.md` + `analysis/lint.ts` (they must agree).
- When you change a lint rule or the data model, update `_fsm-syntax.md` and `design.md` in the same pass, or the LLM will generate against stale rules.
