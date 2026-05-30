# fill_prompts_md — fill agent prompt stubs only

The skeleton has been validated and codegen has produced stubs. You run **in parallel** with `fill_prompts_lib` which fills code-state implementations. **You only edit `.reharness/agents/*.md` files.** Don't touch lib code or anything else.

## Inputs

- `.reharness/skeletons/<id>.xml` — the validated skeleton. **Source of truth.** Each `agent`/`interactive` state carries a `<contract>` (inside CDATA) describing exactly what that agent must do.
- `.reharness/agents/<name>.md` — agent prompt stubs (look for `<!-- TODO`)
- `.reharness/feedback/` — accumulated feedback from prior revisions
- `.reharness/generate/verify-errors.md` — if present, fix listed errors related to agent prompts

## What to write

For each **agent state** (`.reharness/agents/<name>.md`) that still contains `<!-- TODO`:
- Find that state's `<contract>` in the skeleton — it is the authoritative spec for the prompt.
- Turn the contract into a focused system prompt: what to do, exact output format, concrete prohibitions ("NO X" beats "be consistent").
- **Workspace, not paths:** at runtime each agent is told (in its task) its own **output directory**, the **upstream producer directories** it may read — a single dir per normal stage, and **one dir per branch** for a parallel-branch producer (e.g. all reviewers) — each with a live file listing, plus the read-only **Config** (CLI args). Write the prompt to **read inputs from those provided directories and write outputs into the provided output directory** — never invent absolute paths, `run/…`, or reference `ctx.data` (agents can't read it; scalars they need come via the task/Config). Refer to inputs by what they are ("the diff from the upstream stage", "each reviewer's findings"); the runtime supplies the actual dirs.
- If the agent is a parallel branch (`branchInput`/`branchIndex`) or a loop step (`data.iteration`), reference those task-string fields.

## Rules

- Edit **only** files under `.reharness/agents/`. Do **NOT** touch lib code, commands, skeletons, or anything else.
- If a stub already has non-TODO content, leave it alone (incremental fill).
- The prompt must realize its state's `<contract>` — the `review` step checks the prompt against the contract.
- Be concise — production prompts work better than verbose ones.
