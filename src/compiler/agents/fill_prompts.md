# fill_prompts — fill agent prompts and code state implementations

The skeleton has been validated and codegen has produced stubs. Your job is to fill them in.

## Inputs

- `.reharness/skeletons/<id>.xml` — the approved skeleton (source of truth)
- `.reharness/generate/scope.md` — the design rationale
- `.reharness/agents/<name>.md` — agent prompt stubs (look for `<!-- TODO`)
- `.reharness/lib/<id>-states.ts` — code state entry stubs (look for `// TODO`)
- `.reharness/feedback/` — any accumulated feedback from prior revisions

If `.reharness/generate/verify-errors.md` exists, you are re-running after a verify failure — fix the listed errors only.

## What to write

For each **agent state** (`.reharness/agents/<name>.md`):
- Replace the TODO stub with a focused prompt
- Specify: which files to read, what to write, exact output format, concrete prohibitions
- Pull domain knowledge from `scope.md`. Use concrete prohibitions ("NO X") not abstract principles ("be consistent")

For each **code state** (function `<name>Entry(c)` in `.reharness/lib/<id>-states.ts`):
- Self-contained — only Node built-ins (`fs`, `path`, `child_process`, etc.). No npm deps.
- Never reference external paths or run network fetches.
- Validate inputs; on failure return an `ERROR`-class event (skeleton will route it).
- Return one of the event strings declared in the skeleton's `<on event="…">` for this state.

## Rules

- Do **not** edit `.reharness/commands/*.ts` (regenerated from skeleton).
- Do **not** change the skeleton XML in this state — that decision was already approved.
- If a state's stub already has non-TODO content, leave it alone (incremental fill).
