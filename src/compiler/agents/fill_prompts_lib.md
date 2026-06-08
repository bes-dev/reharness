# fill_prompts_lib — fill code-state implementations only

The skeleton has been validated and codegen has produced stubs. You run **in parallel** with `fill_prompts_md` which fills agent prompts. **You only edit `reharness/lib/<id>-states.ts`.** Don't touch agent prompts or anything else.

## Inputs

- `reharness/skeletons/<id>.xml` — the validated skeleton. **Source of truth.** Each `code` state carries a `<contract>` (inside CDATA) describing what the function must do, its declared events, and which upstream stages it reads.
- `reharness/lib/<id>-states.ts` — code-state entry-function stubs (look for `// TODO`)
- `reharness/skills/*.md` — domain-skills from research. **For any external I/O, read the relevant skill's `Integration / I/O` section and implement EXACTLY what it documents** (transport, auth, endpoints). Do NOT improvise an integration from memory — the skill is the grounded truth.
- `reharness/.cache/feedback/` — accumulated feedback from prior revisions
- `reharness/.cache/scratch/verify-errors.md` — if present, fix listed errors related to lib code

## What to write

For each **code state** `<name>Entry(c)` containing `// TODO`:
- Implement the logic described in that state's `<contract>`.
- **The runtime owns paths — never hand-build one** (no `path.join(runDir, …)`, no `os.tmpdir()`). Use the accessors:
  - `c.out()` — write this state's own outputs here: `writeFileSync(join(c.out(), 'result.json'), …)`.
  - `c.dir('<stage>')` — read one upstream producer: `readFileSync(join(c.dir('ingest'), 'diff.txt'), 'utf-8')`.
  - `c.dirs('<stage>')` — read a parallel-branch producer (one dir per branch).
  - A repo you clone *to analyse*, or any scratch, goes in `c.out()` too (it's an inter-stage artifact).
- **An external TARGET the workflow operates on** (a repo, a file, a deploy path) is NOT a workspace artifact:
  - Read/write it via `c.config.<name>` — its declared input. (The workspace-escape check passes a `c.config` path.)
  - NEVER operate on `c.config.target` / `cwd` / `'.'` — `target` is where outputs go, not a user input.
  - NEVER hardcode `os.homedir()`, `process.env.HOME`/`TMPDIR`, or an absolute/`~/` literal.
- Carry only **scalars** into `c.data.*` (flags, counts, ids). Never put a path in `c.data` — artifacts flow through the workspace.
- **Prefer Node built-ins** (`fs`, `path`, `child_process`, `fetch`). An npm dep only when built-ins can't (e.g. PDF) — load it with a **deferred literal** import *inside* the function: `const pdf = (await import('pdfkit')).default`. The literal lets the manifest record it (so `setup.sh` installs it), and deferring it means the module still loads during verification when the dep isn't installed yet — a **top-level** `import pdf from 'pdfkit'` fails verification (it resolves the package at load time, before `setup.sh` runs). **Never** load a package via a runtime variable (`await import(c.config.lib)`), make *which library* a parameter, or `npm install` at runtime (nor write-a-script-then-dynamically-import it) — the manifest can't see any of those, so the dep is never installed and the run fails. If the session showed `npm install X`, that just means X is a dependency: `await import('X')`, nothing more.
- **Network is normal** (clone, API calls, downloads). The entry may be `async`; for HTTP use `await fetch(url, { headers })` as the relevant skill documents.
- **Run subprocesses through the context, not raw `spawnSync`.** When you need a command's **output / exit code** (a build, tsc, a CLI that prints a version), use `const r = await c.exec('npx', ['tsc', '--noEmit'], { timeoutMs })` → `{ ok, status, stdout, stderr }`. When a boolean is enough, use `await c.shell(cmd)`. Both are **abortable + timeout-bounded + dry-run-stubbable** — a raw `spawnSync`/`execSync` blocks the event loop (Ctrl+C can't interrupt it) and runs for real even under `--dry-run`. Reach for `child_process` directly only when you genuinely need synchronous semantics.
- **Substrate rules (never violate):**
  - ESM module: `require`/`__dirname`/`__filename` throw. Use `import` / `await import('pkg')` and `import.meta.url`.
  - Never `node -e`/`--eval` a constructed string. Do the work in-process, or write a `.js` to `c.out()` and run `node <file>`.
  - Keep secrets in memory (a header, a `spawnSync` argv). Never interpolate a secret into a shell string. For git use `spawnSync('git', [args])`.
- **Determinism = ROUTING, not purity.** I/O may fail nondeterministically — funnel every outcome into a **declared event** (e.g. 200→DONE, 4xx/5xx→FAIL, timeout→a retry event) and on failure set a human-readable `c.data.error`; transient failures route via the FSM's `retries-key`/`retries-max`, not in-function loops.
- **Swallowing a best-effort failure?** If the contract says an output is optional and must not block the happy path, catch its failure, then **call `c.warn('<what degraded and why>')`** (not a silent `emit`) before returning the success event — so a succeeded-but-degraded run stays visible to `evolve`, which can later repair the leaf.
- **Never call `ctx.agent` / `c.agent` from a code state** — code states are deterministic in their decision logic (no judgement/LLM). LLM calls belong to declared `agent` states.
- **Return type is already typed** in the stub signature (e.g. `'SKIP' | 'DEBATE'`). Return only events in that union — TypeScript rejects others at verify. To fail a path, throw — codegen wraps exceptions as `'ERROR'`.
- Handle undefined `ctx.config.*` / `ctx.data.*` defensively (sensible defaults).

## Rules

- Edit **only** `reharness/lib/<id>-states.ts`. Do **NOT** touch agent prompts, commands, skeleton, or anything else.
- If a function already has a non-TODO body, leave it alone (incremental fill).
- No new helper files — logic lives in entry functions or local helpers in the same file.
