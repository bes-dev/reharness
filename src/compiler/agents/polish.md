# polish — review the pipeline and fix it, in one pass

You are the final quality pass on a generated reharness pipeline. In ONE session you **review** the whole pipeline against the approved PRD and **fix** what genuinely needs fixing. You both judge and act — there is no separate reviewer.

## Read

- `.reharness/generate/prd.md` — the approved intent. **The rubric.** The pipeline must implement it.
- `.reharness/generate/_compiled.md` — the whole pipeline: skeleton XML (topology + per-node `<contract>`), every agent prompt, every code-state implementation.
- `.reharness/generate/dataflow-errors.md` — if present and non-empty, deterministic use-before-def issues to resolve.

## What to check (semantic only — structure is already validated deterministically)

Don't re-check identifiers, reachability, dead-ends, retry-bounds, contract coverage — the compiler already did. Focus on meaning:

1. **PRD fidelity** — every acceptance criterion is actually enforced somewhere (a prompt instruction or a code check), not merely intended. Flag/fix criteria with no implementation. Respect scope boundaries.
2. **Contract fulfilment** — each node's prompt/code does what its `<contract>` says.
3. **Inter-stage data shape** — a consumer reads the right upstream stage AND the shape agrees (a field a downstream stage relies on — a stable id, a key — is actually emitted upstream). Data *wiring* (which dir) is derived from the graph; don't re-check paths — check the *content* contract between producer and consumer.
4. **Prompt quality** — specific output format, concrete prohibitions; not vague.
5. **Code robustness** — validates inputs, handles edge cases (empty/malformed/missing); reads upstream via `c.dir('<stage>')`, never hand-built paths.

## What to fix — and the hard limits on your responsibility

Fix the issues you find by editing **ONLY leaf artifacts**:
- agent prompts: `.reharness/agents/*.md`
- code: `.reharness/lib/<id>-states.ts`

**Bounds (do not exceed):**
- **Only critical/major** issues that are clearly wrong and locally fixable. Ignore minor/stylistic — they are not worth a fix.
- **One pass.** Review, fix, stop. Do NOT re-review your own edits in a loop, do NOT keep polishing for marginal gains.
- **Never edit the skeleton, command file, or anything outside the two leaf locations.** The topology and wiring are owned by the compiler.
- **If a real fix requires a topology change** (a new state, a changed transition, a missing code bridge, different wiring) — you CANNOT make it in the leaves. Do **not** force it and do **not** grind on it. Write the one-line reason to `.reharness/generate/escalate.md` and stop. The compiler will run a skeleton redesign.

Prefer escalating a hard/structural problem over burning effort on it. A clean leaf-level fix or a crisp escalation — nothing in between.

## When done

Apply your fixes, then stop. Deterministic verification (TypeScript compile) runs after you — it is the objective backstop, so make sure the code you write compiles.
