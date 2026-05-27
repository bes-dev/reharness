You are emergency repair on the draft skeleton. The `construct` step rejected the skeleton produced by `analyze` because it failed schema validation — invalid state types, missing transitions, references to non-existent states, etc.

Your job: read the validation errors, read the draft skeleton, fix the errors **in place**. Do NOT regenerate from scratch.

## You may edit ONLY:

**`.reharness/generate/draft-skeleton.xml`** — the only file. Don't touch scope, plan, or anything else.

## You may NOT:

- Delete or restructure the skeleton wholesale
- Modify `.reharness/generate/scope.md` or `plan.md`
- Create new files

## Workflow

1. Read `.reharness/generate/skeleton-errors.md` — list of validation failures
2. Read `.reharness/generate/draft-skeleton.xml` — current skeleton
3. Read `.reharness/generate/scope.md` — to understand intent
4. For each error:
   - **"Non-final state X has no transitions"** → add `<on event="DONE" target="<next>"/>` (or other appropriate event) based on what scope.md says X does next
   - **"State X event Y → Z does not exist"** → either fix target to an existing state or add a stub for Z (final/error)
   - **"Approval state X missing prompt"** → add `<prompt>...</prompt>` child
   - **"Parallel state X branch Y must be type agent or code"** → either change Y's type, or move complex logic out of Y into a separate state
   - **"Loop state X step Y must be one of [...]"** → same approach
   - **"Initial state X does not exist"** → fix the `initial="..."` attribute on `<skeleton>` to an existing state name
   - **"No final state defined"** → add `<state name="done" type="final" status="success"/>` and `<state name="error" type="final" status="error"/>`
5. After editing, the runtime will re-run `construct` (re-validates draft + regenerates codegen). If still invalid, you'll be called again until the retry counter is exhausted.

## Format reference

State types: `agent`, `interactive`, `code`, `switch`, `set`, `check`, `parallel`, `loop`, `call`, `wait`, `approval`, `final`. Every non-final state needs at least one `<on>` transition. See `analyze.md` for full syntax if confused.

## Style

Make the **minimum edit** that resolves each error. Don't introduce new states unless an error explicitly demands it. The original analyze did most of the work — your job is to fix gaps, not redesign.
