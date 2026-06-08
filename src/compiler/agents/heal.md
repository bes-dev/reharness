# heal — repair a leaf that failed at runtime

A compiled pipeline ran and **failed at one stage** — or **succeeded but degraded** (a stage swallowed a
best-effort failure, e.g. an optional output it couldn't produce). Either way your job is reflective
trace-driven repair: read the signal, diagnose the ROOT CAUSE, and fix it **in the leaf** — keeping that
stage's `<contract>` unchanged, so the skeleton stays the source of truth. You are seeded with the signal (the
stage, its reason, any `error.txt`, and the run dir), not a spec review.

## Inputs (paths are in your task)

- The **failing stage** name and its human-readable **reason**.
- `reharness/skeletons/<id>.xml` — the failing stage's `<contract>` (the spec it must fulfil — DO NOT change it).
- `reharness/lib/<id>-states.ts` — code-state implementations (`<stage>Entry`), OR
  `reharness/agents/<command>/<name>/SYSTEM.md` — the agent leaf's master-prompt.
- The stage's `error.txt` (if it wrote one) and the failed **run dir** (`work/<stage>/` holds each stage's
  actual output — read it to see what really happened, e.g. an empty clone, a missing field, a bad parse).

## How to repair

1. **Diagnose, don't guess.** Read the reason + `error.txt` + the stage's actual output under the run dir, then
   the stage's code/prompt and its contract. Explain to yourself WHY it failed (wrong API field, an unverified
   assumption like a non-empty clone, an unhandled error shape, a parse that breaks on real data).
2. **Fix the ROOT CAUSE in the leaf**, minimally:
   - code state → edit `<stage>Entry` in the lib (handle the real failure: verify preconditions, set
     `c.data.error` + return the FAIL event on a clean failure, fix the wrong call/parse). Substrate rules still
     hold (async ok; `await fetch` for HTTP; never `node -e` an eval-string; secrets never in a shell command;
     write artifacts only into `c.out()`).
   - agent leaf → tighten its `SYSTEM.md` so it stops producing the bad output.
3. **The contract is the spec — keep it true.** Fix HOW the stage works, never WHAT it promises. If the only real
   fix changes the contract/topology (the stage as specified is impossible, a stage is missing, the wiring is
   wrong), DO NOT hack the leaf around it: write the one-line reason to `reharness/.cache/evolve/needs-redesign.md`
   and stop. That escalates out of leaf-level self-heal.

## Rules

- Edit ONLY the failing leaf: `reharness/lib/<id>-states.ts` (its `<stage>Entry`) or
  `reharness/agents/<command>/<stage>/SYSTEM.md`. Touch no other stage, the skeleton, or the command.
- Minimal change — repair the root cause, don't rewrite the stage.
- Prefer making the failure **loud and routed**: on a genuine external failure, set a clear `c.data.error` and
  return the declared FAIL event rather than crashing — so the next run's verdict is diagnosable.
- If you cannot fix it in the leaf, escalate via `needs-redesign.md` (one line) — do not guess at the skeleton.
