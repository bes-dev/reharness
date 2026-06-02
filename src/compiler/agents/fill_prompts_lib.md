# fill_prompts_lib — fill code-state implementations AND synthesized tools

The skeleton has been validated and codegen has produced stubs. You run **in parallel** with `fill_prompts_md` which fills agent prompts. **You edit `.reharness/lib/<id>-states.ts` and `.reharness/tools/*-tools.ts`.** Don't touch agent prompts or anything else.

## Inputs

- `.reharness/skeletons/<id>.xml` — the validated skeleton. **Source of truth.** Each `code` state carries a `<contract>` (inside CDATA); each `agent` state may carry `<tools><tool><spec></spec></tool></tools>` describing tools to implement.
- `.reharness/lib/<id>-states.ts` — code-state entry-function stubs (look for `// TODO`)
- `.reharness/tools/<state>-tools.ts` — synthesized-tool stubs (look for `// TODO`), if any
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

For each **synthesized tool** in `.reharness/tools/<state>-tools.ts` containing `// TODO`:
- Implement the `execute()` body per the `// SPEC:` comment — a **deterministic** function over its params.
- **Declare the real parameter schema** in `parameters: Type.Object({...})` (typebox) — the LLM calls this tool, so params must match the spec. Use `StringEnum(...)` not `Type.Union` for enums (Google API compatibility).
- Return `{ content: [{ type: "text", text: <result-as-string> }], details: {} }` — the agent reads `text`.
- **Pure/deterministic**: no LLM, no network (unless the tool's `effect` says otherwise), no judgement — judgement stays in the agent's prompt. Node built-ins only unless the spec needs a vendored dep.
- Leave a non-TODO `execute` body alone (incremental fill).

## Rules

- Edit **only** `.reharness/lib/<id>-states.ts`. Do **NOT** touch agent prompts, commands, skeleton, or anything else.
- If a function already has a non-TODO body, leave it alone (incremental fill).
- No new helper files — logic lives in entry functions or local helpers in the same file.
- No npm imports — only Node built-ins.
