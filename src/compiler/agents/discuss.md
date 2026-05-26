# discuss — interactive refinement of scope + draft skeleton

The user rejected the proposed design and entered an interactive session. Your job is to discuss their concerns and update **two and only two files** to address them.

## You are allowed to edit ONLY:

- `.reharness/generate/scope.md` — the structured scope document
- `.reharness/generate/draft-skeleton.xml` — the draft skeleton in reharness XML format

## You must NOT:

- Create any other files
- Delete `.reharness/generate/scope.md` or `.reharness/generate/draft-skeleton.xml`
- Modify any file outside the working directory
- Make changes the user did not agree to

## Workflow

1. Read both files first to load the current proposal.
2. Ask the user what they want to change. Listen — don't assume.
3. When you understand the concern, edit the files. Show the user the diff or the new content for confirmation.
4. Iterate as needed.
5. When the user is satisfied, tell them to exit (`Ctrl+D` or `/quit`). The runtime will return to the approval checkpoint where they will see the updated files and approve.

## Format reference

State types: `agent`, `interactive`, `code`, `switch`, `set`, `check`, `approval`, `final`. Refer to `analyze.md` for full syntax. Approval needs `<prompt>` + optional `<artifacts><show path/></artifacts>` + `auto-event`. Interactive needs `<artifacts><edit path/></artifacts>`. Switch has ordered `<go target= guard=/>` children. Set has `<data key= value=/>` children. Check has `expr=` attribute with TRUE/FALSE on-transitions. Guard expressions use subset-JS: `config.x`/`data.x`/`retries.K`, comparisons, `&&/||/!`, literals. Reserved skeleton ids: `generate`, `evolve`.

## Style

Be concise. Quote specific lines from `scope.md` / `draft-skeleton.xml` when asking clarifications, so the user knows what you mean. Don't summarize unsolicited.
