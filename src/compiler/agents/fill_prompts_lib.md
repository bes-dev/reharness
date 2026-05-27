# fill_prompts_lib — fill code-state implementations only

The skeleton has been validated and codegen has produced stubs. You are running **in parallel** with `fill_prompts_md` which is filling agent prompts. **You only edit `.reharness/lib/<id>-states.ts`.** Don't touch agent prompts or anything else.

## Inputs

- `.reharness/skeletons/<id>.xml` — the approved skeleton (source of truth for which code states exist, their declared events, and data flow)
- `.reharness/generate/scope.md` — the design rationale, especially the Wiring contract section
- `.reharness/lib/<id>-states.ts` — code-state entry function stubs (look for `// TODO`)
- `.reharness/feedback/` — any accumulated feedback from prior revisions
- `.reharness/generate/verify-errors.md` — if present, fix listed errors related to lib code
- `.reharness/generate/review-report.md` — if present and starts with FAIL, address issues mentioning `lib/`

## What to write

For each **code state** function `<name>Entry(c)` in `.reharness/lib/<id>-states.ts` that contains `// TODO`:

- Implement business logic per the corresponding stage in `scope.md`
- **Self-contained** — only Node built-ins (`fs`, `path`, `child_process`, etc.). No npm deps.
- Never reference external paths or run network fetches.
- Validate inputs; on failure return one of the declared FAIL/ERROR events (skeleton routes it).
- **Return type is already typed** in the stub signature (e.g. `'SKIP' | 'DEBATE'`). Do not return any event outside this union — TypeScript will reject it at verify time. If a path needs to fail, let an exception throw (codegen wraps thrown exceptions as `'ERROR'` automatically).
- For state's that read `ctx.config.*` or `ctx.data.*` fields, ensure they correctly handle the case where those fields are undefined (defensive defaults).
- Wire config fields per the Wiring contract section in `scope.md`. Every claim that "config.X is consumed by Y entry function" must be realized in your code.

## Rules

- Edit **only** `.reharness/lib/<id>-states.ts`. Do **NOT** touch agent prompts, commands, skeleton, scope, or anything else.
- If a function already has a non-TODO body, leave it alone (incremental fill).
- Don't invent new helper files — all logic lives in the entry functions or local helpers within the same lib file.
- Don't import from npm packages — only Node built-ins.
