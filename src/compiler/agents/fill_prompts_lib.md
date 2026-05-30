# fill_prompts_lib — fill code-state implementations only

The skeleton has been validated and codegen has produced stubs. You run **in parallel** with `fill_prompts_md` which fills agent prompts. **You only edit `.reharness/lib/<id>-states.ts`.** Don't touch agent prompts or anything else.

## Inputs

- `.reharness/skeletons/<id>.xml` — the validated skeleton. **Source of truth.** Each `code` state carries a `<contract>` (inside CDATA) describing what the function must do, its declared events, and which upstream stages it reads.
- `.reharness/lib/<id>-states.ts` — code-state entry-function stubs (look for `// TODO`)
- `.reharness/feedback/` — accumulated feedback from prior revisions
- `.reharness/generate/verify-errors.md` — if present, fix listed errors related to lib code

## What to write

For each **code state** `<name>Entry(c)` containing `// TODO`:
- Implement the logic described in that state's `<contract>`.
- **Paths are owned by the runtime — never build one by hand** (`path.join(runDir, …)`, `run/…`). Use the accessors (the stub lists this state's upstream producers):
  - **write this state's own output files into `c.out()`** — e.g. `writeFileSync(join(c.out(), 'result.json'), …)`.
  - **read a single upstream producer via `c.dir('<stage>')`** — e.g. `JSON.parse(readFileSync(join(c.dir('ingest_diff'), 'diff.txt'), 'utf-8'))`.
  - **read a parallel-branch producer via `c.dirs('<stage>')`** (one dir per branch) — e.g. `for (const d of c.dirs('reviewer')) { … readFileSync(join(d, 'findings.json')) … }`.
- Carry scalar values that guards/switches need into `c.data.*` (that is what `ctx.data` is for).
- **Self-contained** — only Node built-ins (`fs`, `path`, `child_process`). No npm deps. No network.
- **Never call `ctx.agent` / `c.agent` from a code state** — code states are deterministic. LLM calls belong to declared `agent` states.
- **Return type is already typed** in the stub signature (e.g. `'SKIP' | 'DEBATE'`). Return only events in that union — TypeScript rejects others at verify. To fail a path, throw — codegen wraps exceptions as `'ERROR'`.
- Handle undefined `ctx.config.*` / `ctx.data.*` defensively (sensible defaults).

## Rules

- Edit **only** `.reharness/lib/<id>-states.ts`. Do **NOT** touch agent prompts, commands, skeleton, or anything else.
- If a function already has a non-TODO body, leave it alone (incremental fill).
- No new helper files — logic lives in entry functions or local helpers in the same file.
- No npm imports — only Node built-ins.
