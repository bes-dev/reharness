# Evolution model

`evolve` (shipped — `src/compiler/evolve.ts` + `evolve-ledger.ts` + `evolve-gate.ts`) is **trace-driven speedup learning + reflective repair, gated by the utility problem** — a deliberate *restriction* of well-studied learning models, the dynamic twin of the static amortization that `/generate` already performs. Where `generate` amortizes what is *statically* visible as mechanical (agent→code demotion), `evolve` amortizes what is *dynamically observed* in run traces — driven by runtime signal, not static judgement. Read before touching `src/compiler/evolve*`. The shipped pipeline matches this design: the self-heal track is `read_verdict → heal → verify → replan → construct → fill_changed → verify_replan → confirm_rerun`; the amortization track is `refine_skills → extract → reconcile_tools → update_ledger → retention_trim`.

## The model — two theoretically-distinct tracks

Both ingest a run **trace**, route to the *existing* correction/enhancement agents (`polish` / `redesign` / `enhance`) as actuators, and are guarded by the verify/Code-Gate regime. They are different learning problems:

- **Track 1 — tool-gen (amortization) = a restriction of SPEEDUP LEARNING.** Detect a repeated *deterministic* sub-routine in an agent's reasoning trace → compile it into a cached tool the agent can call.
  - The COMPILE step is **Explanation-Based Generalization** (explain *why* a trace succeeded → take weakest preconditions), equivalently SOAR **chunking**, ACT-R **production compilation**, and STRIPS/Korf **macro-operator learning**. In PL terms the cached tool is a **partial-evaluation / memoization residual**.
  - The **determinism precondition is FORMAL, not ad-hoc**: EBL and partial-evaluation are sound only for referentially-transparent computation. The detector targets deterministic routines *for that reason*.

- **Track 2 — bugfix / self-heal (repair) = reflective trace-driven repair.** A run that hit the `error` terminal → explain *why* it failed (not just *that* it failed) → propose a targeted fix. This is automated program repair / reflective credit assignment, a different problem from amortization.

## Extraction is N=1; the utility problem governs RETENTION (over N)

The two are separate decisions and must not be conflated:

- **Extraction yields value from a SINGLE trace (N=1).** EBG formally generalizes from one explained example; empirically Voyager commits a skill after one self-verified success. The extraction *trigger* is **EBL-explainability** — can we explain, from one trace, why this sub-routine worked such that it generalizes — **not** frequency.
- **Retention is the UTILITY PROBLEM** (Minton): keep a learned routine iff `utility = frequency × savings − match/dispatch cost > 0`. Indiscriminate caching makes the system *slower* (proven). Utility is an estimate that **accumulates over runs** — more trajectories sharpen it; they are a *strengthener*, never a prerequisite.

So the gate is **two-stage**:
- **Acquisition gate (fires at N=1):** correctness — the tool/fix preserves the behaviour of the reasoning it replaces (EBG soundness + the existing tsc / substrate / workspace verify regime). A behaviour-preserving artifact is safe to keep provisionally from the first run.
- **Retention gate (accumulates over N):** utility — trim by frequency/savings vs cost (the modern echo: TroVE's `λ = ½·log₁₀(n)` trim; and **price context-bloat** — more tools = more context = slower/worse, the LLM-era utility problem); retrieve top-k by embedding to bound per-call cost.

## Invariants (respect these)

- **Every run yields a verdict — no empty runs.** A failed run → an improvement (Track 2). A successful run → either a candidate (Track 1 extraction) or a **proof-of-stability** (a regression baseline *and* an update to the accumulating utility estimate of existing tools). `evolve` is a **continuous per-run feedback loop, not a batch job**: it produces feedback every run, and *acts* (fixes / extracts / trims) only when a verdict warrants.
- **The skeleton stays the source of truth (fragmentation preserved).** `evolve` reuses `generate`'s correction hierarchy, which already encodes where each change lives: a leaf-implementation fix patches the lib directly **only** while the contract is unchanged (like `polish`); any change to the spec/contract/topology goes through `skeleton.xml` (like `redesign`); a new tool/skill is an additive harness layer (like `enhance`). **The code must never diverge from its contract** — that is what keeps the skeleton truthful.
- **The Code Gate is correctness AND utility.** Framing it as tsc/substrate correctness alone is incomplete; the utility problem makes the retention half mandatory (else tool-library bloat degrades the very runtime evolve is meant to cheapen).

## Deliberate restrictions (NOT bugs — do not "fix" by adding these)

- **No evolutionary search (GEPA / DSPy-MIPRO) in the base.** Reflective Pareto prompt evolution is a separate *pipeline-optimization* layer (this is exactly what Hermes's offline `hermes-agent-self-evolution` does — optimize skill *text* against eval datasets). Deliberately backlogged; v1 is direct `detect → diagnose → route-to-fixer → re-verify`.
- **No weight training.** Tools/skills/fixes are artifacts (code, prompts, skeleton edits), never fine-tuning.
- **Operates INSIDE a verified compiled pipeline, not a flat skill folder.** This is the key difference from Hermes (free-floating `~/.hermes/skills/*.md`, kept by usage-decay + LLM taste): our artifacts live in a structured pipeline where the Code Gate leans on the whole verify regime (tsc + substrate + derived dataflow), not just unit tests. `evolve` is speedup learning grounded by a real compiler gate.

## References

Speedup learning: EBL/EBG — Mitchell/Keller/Kedar-Cabelli 1986; DeJong/Mooney 1986. Chunking — Laird/Rosenbloom/Newell 1986 (SOAR). Production compilation — Anderson 1983 (ACT-R). Macro-operators — Fikes/Hart/Nilsson 1972; Korf 1985. Partial evaluation — Futamura 1971/83. **The utility problem** — Minton 1988 (AAAI-88) / 1990 (AIJ 42); expensive chunks — Tambe/Newell/Rosenbloom 1990; information filtering — Markovitch & Scott 1993. Modern instantiations: Voyager (arXiv 2305.16291), LATM (2305.17126), TroVE (2401.12869), CREATOR (2305.14318), Toolformer (2302.04761); pipeline optimization — DSPy (2310.03714), MIPRO (2406.11695), GEPA (2507.19457); survey (2507.21046). Contrast system: NousResearch `hermes-agent` (online SKILL.md self-authoring + Curator decay) and `hermes-agent-self-evolution` (offline DSPy+GEPA on skill text).
