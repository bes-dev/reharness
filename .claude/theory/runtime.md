# Runtime execution model

`src/runtime/fsm.ts` is a **deterministic hierarchical Moore-action transducer with run-to-completion (RTC)** — a deliberate, well-defined *restriction* of the UML/Harel hierarchical state machine. It was built intuitively but is theoretically clean; the control core needed *naming*, not rewriting. (The authoritative statement also lives as a docstring atop `fsm.ts`.)

## The model

- **States are Moore actions.** Each active state runs an `entry` action (agent / code / set / interactive) **to completion**, then emits exactly ONE event symbol — the *outcome of its own computation*, not an external input. There are no Mealy transition-actions and no entry/exit-on-nesting actions; the action is tied to the state (Moore). `entry` returning `void` ≡ the `DONE` event.

- **Run-to-completion.** The outer loop `await`s the full action before selecting a transition. There is no event queue and no preemption — exactly one event per step — so RTC's "no internal concurrency within a step" holds trivially. `wait` states are the only external-signal source (timer/file/shell/webhook).

- **Total, deterministic transition function δ.** δ(state, event) is `transitions[event]`, then resolved by **ordered first-true guard** (`resolveTarget`). This is *stricter* than UML, which leaves guard order unspecified. Every gap **fails loud** via `fail(...)`: unhandled event, no-guard-match, switch with no matching branch. **The machine never silently stalls** — partiality of δ is turned into an explicit error.

- **Hierarchical composites are RTC sub-computations, NOT orthogonal regions.** Run by recursion (`executeStateOnce` / `runParallel` / `runLoop`) and returning a completion; the top level stays single-active.
  - `parallel` = **fork-join** over a data array. No inter-branch event broadcast.
  - `loop` = **bounded iteration**. `max` is REQUIRED (the loop variant ⇒ guaranteed termination); `exit` is an optional early-out, never a substitute (an `exit`-only loop could diverge on a never-true predicate — a real risk with LLM-authored guards).
  - `call` = a sub-machine (another compiled pipeline).

## Parallelism: real for agents, cooperative for code

`runParallel` is a **worker pool** of `concurrency` coroutines on Node's single event loop (`await Promise.all(workers)`). The reality depends on the branch type:

| branch type | parallelism | why |
|---|---|---|
| agent / interactive | **REAL** | each branch `spawn`s a separate `pi` OS process and awaits it; up to `concurrency` subprocesses (and their LLM calls) run genuinely at once → wall-clock ≈ slowest branch |
| code / set | **cooperative only** | runs *in* the event loop (single thread); CPU-bound code interleaves only at `await` points → effectively serial |

This is correct for an **I/O-bound** agent-orchestration workload (the useful work — LLM reasoning — is in subprocesses). True CPU parallelism for code would need `worker_threads`; we deliberately don't.

## Invariants callers must respect (the RTC boundary)

- **Each `parallel` branch gets its own shallow copy of `ctx.data`** (forked at the split). Concurrent branches — including nested composites (a branch that is itself a loop/parallel/wait, which makes the *runtime* write `data.iteration`/`data.iterations`/`data.branches`/`data.waitEvent`) — therefore never race on the scalar bus. A branch's `ctx.data` writes are **branch-local** and do NOT propagate to the parent; branches communicate through their isolated output dirs, and the join reads `data.branches`. (The directory model was always per-instance race-free; this isolates the scalar bus too — see `parallel-composite.test.ts`.)
- **Resume is coarse:** only `current` + `data` are persisted, so resuming mid-composite re-runs that composite from the start. Acceptable because composite steps re-derive (idempotent), not append.
- **Per-run hyperparameter overrides preserve every invariant.** `RunOptions.overrides` (a flat `state.knob → value` map; CLI `--param`) replaces a loop's `max`, a parallel's `concurrency`, or a state's `timeoutMs` for one run. It is purely a *value* substitution at the use site — it adds no state, transition, or control-flow path, so δ stays total and fail-loud. The map is validated once at run start (fail-loud on an unknown state/knob or a bad value); in particular a `max` override must be a finite integer ≥1, so the loop-termination guarantee is never weakened by an override.
- **Per-agent watchdog — liveness vs ceiling, the two-timer model.** A fixed wall-clock `timeoutMs` kills a slow-but-working agent and a hung one alike — wrong for a poorly-predictable horizon (deciding "slow vs stuck" is the halting problem). So an agent leaf has, in addition to its state-level `timeoutMs`, an optional watchdog (`agent.ts:armWatchdog`, fed by config + `--param`): **L1 `idleMs`** resets on every backend stream event, so it waits on a *producing* leaf and kills only a *silent* one; **L3 `maxMs`/`maxUsd`/`maxTokens`** are non-extendable ceilings (spanning retries) that bound a live-but-runaway agent ("playing solitaire"). Only the ceiling makes liability truly limited — a leaf that games liveness by emitting forever still dies. This adds **no new δ path**: a trip kills the subprocess and the leaf throws, routed through the *existing* fail-loud handling (and recorded in the verdict). It is the per-leaf analog of "loops require `max`" — a termination guarantee. All knobs default 0 = disabled (opt-in); see `agent-watchdog.test.ts`.
- **The workspace (`c.out`/`c.dir`/`c.dirs`) is entry-only.** A stage is bound only while its `entry` (or a branch/step) runs. **Guards and exit actions** run at a transition point with no bound stage and read **only the scalar bus** (`ctx.data`/`config`/`retries`) — routing is a scalar decision (the analyzer's config-flow check assumes this). Calling a workspace accessor from a guard/exit fails loud rather than returning a wrong path.

## Observed cost (the run verdict)

- The runtime **measures** what a run spent: each agent leaf reports its Pi usage (`AgentUsage` in `agent.ts`), the FSM sums them per run (`fsm.ts`), and the terminal persists `usage: { costUSD, tokensIn, tokensOut, agentRuns }` into the saved state and emits `runtime: N agent run(s) · X tokens · $Y`. Self-hosting means one accounting point covers both compile cost and per-command cost.
- Cost is **observed, never estimated**, and it makes the core claim falsifiable: a fully-amortized (0-agent) pipeline shows `0 agent run(s) · 0 tokens · $0.0000` — the LLM cost is paid once at compile, not per run. Spend lives only at agent leaves; code/set/switch/loop/parallel scaffolding is free.

## Deliberate restrictions vs full UML/SCXML HSM (NOT bugs — do not "fix" by adding these)

- No orthogonal-region event broadcast; no LCA-based exit/entry bubbling; no event queue (one computed event per step).
- The nondeterminism of the system lives entirely in the **agent leaves**; the FSM is the **deterministic skeleton**. That separation is the whole point — keep it.

## References

UML state machine semantics (RTC, Moore/Mealy, HSM) — en.wikipedia.org/wiki/UML_state_machine; Samek, *A Crash Course in UML State Machines*; Harel statecharts → W3C SCXML (the hierarchical+parallel lineage our `skeleton.xml` restricts).
