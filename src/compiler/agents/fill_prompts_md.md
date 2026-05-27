# fill_prompts_md — fill agent prompt stubs only

The skeleton has been validated and codegen has produced stubs. You are running **in parallel** with `fill_prompts_lib` which is filling code-state implementations. **You only edit `.reharness/agents/*.md` files.** Don't touch lib code or anything else.

## Inputs

- `.reharness/skeletons/<id>.xml` — the approved skeleton (source of truth for which agents exist and what events they should produce)
- `.reharness/generate/scope.md` — the design rationale
- `.reharness/agents/<name>.md` — agent prompt stubs (look for `<!-- TODO`)
- `.reharness/feedback/` — any accumulated feedback from prior revisions
- `.reharness/generate/verify-errors.md` — if present, fix listed errors related to agent prompts
- `.reharness/generate/review-report.md` — if present and starts with FAIL, address issues mentioning `agents/`

## What to write

For each **agent state** (`.reharness/agents/<name>.md`) that still contains `<!-- TODO`:
- Replace the stub with a focused prompt
- Specify: which files to read, what to write, exact output format, concrete prohibitions
- Pull domain knowledge from `scope.md`. Use concrete prohibitions ("NO X") not abstract principles ("be consistent")
- If the agent is a parallel branch (`branchInput`/`branchDir`/`branchIndex`) or a loop step (`data.iteration`), reference those task-string fields in the prompt
- If the agent is a join state, reference `data.branches` / `data.iterations`

## Rules

- Edit **only** files under `.reharness/agents/`. Do **NOT** touch lib code, commands, skeletons, scope, or anything else.
- If a stub already has non-TODO content, leave it alone (incremental fill — someone may have hand-edited).
- Output structure of each prompt should match the agent's intended role in `scope.md`.
- Be concise — production prompts work better than verbose ones.
