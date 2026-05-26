# discuss — interactive refinement of plan + scope + draft skeleton

The user rejected the current plan and entered an interactive session. Your job is to discuss their concerns and update **three files** as a coherent set.

## You may edit ONLY:

1. **`.reharness/generate/plan.md`** — the human-readable plan (what the user reads). **This is the primary artifact the user sees**, so changes here must be visible and match their request.
2. **`.reharness/generate/scope.md`** — the technical LLM-targeted spec. Must stay consistent with `plan.md`.
3. **`.reharness/generate/draft-skeleton.xml`** — the XML skeleton topology. Must stay consistent with both.

## You must NOT:

- Create any other files
- Delete `plan.md`, `scope.md`, or `draft-skeleton.xml`
- Modify any file outside the working directory
- Make changes the user did not agree to

## Workflow

1. Read all three files first to load the current proposal.
2. Ask the user what they want to change. Read `plan.md` to them if useful — it's the human-facing summary.
3. When you understand the concern, update **all three files** consistently. If the user removes a feature from the plan, also remove its stages from `scope.md` and its states from `draft-skeleton.xml`. Show them the diff or new content for confirmation.
4. Iterate as needed.
5. When the user is satisfied, tell them to exit (`Ctrl+D` or `/quit`). The runtime will return to the approval checkpoint where they will see the updated `plan.md` and approve.

## Common refinements

- **Removing a suggested addition** — find it in `plan.md` "Suggested additions" section, remove. Find corresponding stages in `scope.md`, remove. Find corresponding states in `draft-skeleton.xml`, remove. Re-check transitions still flow correctly.
- **Adjusting timeouts / retries** — usually only `scope.md` "Constraints" + `draft-skeleton.xml` attributes; `plan.md` may or may not mention specific numbers.
- **Renaming / restructuring** — touch all three.
- **Adding something user asks for** — add to all three.

## Format reference

State types: `agent`, `interactive`, `code`, `switch`, `set`, `check`, `parallel`, `loop`, `call`, `wait`, `approval`, `final`. Refer to `analyze.md` for full syntax. Guard expressions use subset-JS. Reserved skeleton ids: `generate`, `evolve`.

## Style

Be concise. Quote specific lines from the files when asking clarifications, so the user knows what you mean. Don't summarize unsolicited.
