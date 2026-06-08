# Compiler agents — ownership & reuse

These are the prompts for the **compiler's own self-hosted pipelines** (`generate`, `enhance`, `evolve`). Each is
a master prompt loaded by name via `c.agent("<name>")` / `c.interactive("<name>")` from the built-in agents dir
(`dist/compiler/agents/`). They are flat files (`<name>.md`) — the runtime's `resolvePrompt` resolves a flat
`<name>.md` for these meta-agents (and `<name>/SYSTEM.md` for generated per-pipeline agents). Not a clean tree:
two are **shared** across pipelines, so ownership is a small graph, not folders.

> This is the COMPILER's agents. A *generated* pipeline keeps its own agent prompts under `reharness/agents/<command>/<name>/SYSTEM.md`.

## Who owns what

| Agent | Used by | Purpose |
|---|---|---|
| `research.md` | generate (`research`, both grounding fronts) | **one evidence-adaptive grounder**: write `reharness/skills/<topic>.md` from whatever is present — the request, a recorded session/trace (observed), a harness (written), the web (gaps) — prioritizing observed > written > web > memory and reconciling conflicts; records provenance + reducibility verdict |
| `prd.md` | generate | distil request + skills → the human-approved PRD (description front) |
| `distill.md` | generate (`distill`) | distil a recorded SESSION (a demonstration), grounded by `research`'s skills → the PRD (session front, PBD/EBG) |
| `condense.md` | generate (`condense_chunk`) | map step: condense one slice of a large session into a trajectory digest |
| `amend_prd.md` | generate (`amend`) | fold a feature request into the existing PRD (amend front) |
| `amend_design.md` | generate (`amend`) | apply a minimal skeleton delta to the seeded draft |
| `discuss_prd.md` | generate (interactive) | refine the PRD with the user before design |
| `design.md` | generate | PRD → skeleton (graph + per-node `<contract>`) |
| `redesign.md` | generate | rare escalation: edit the **draft** skeleton when polish can't fix in leaves |
| `polish.md` | generate | one-pass semantic correction of the generated leaves (prompts + code) |
| `patch_node.md` | generate (`fix_verify`) | scoped fix of TS/verify errors in the lib |
| `harness_leaf.md` | enhance | per-leaf: attach a domain-skill / bind a capability (minimal intervention) |
| `heal.md` | evolve | self-heal: repair the failing **leaf** from a run's failure trace (contract unchanged) |
| `replan.md` | evolve | auto-redesign: repair the **skeleton** when a failure can't be fixed in a leaf |
| `extract_tool.md` | evolve | amortize a repeated mechanical routine from a leaf's trace into a Pi tool (`.mjs`) |
| `refine_skill.md` | evolve | sharpen an attached domain-skill where the trace shows it misled the leaf |

## Shared (reused across pipelines)

| Agent | Shared by | Note |
|---|---|---|
| `fill_prompts_md.md` + `fill_prompts_lib.md` | **generate** (`fill_prompts`) **+ evolve** (`fill_changed` after `replan`) | fill agent-prompt / code-state stubs from the skeleton contracts |
| `_fsm-syntax.md` | appended (via `{ append: "_fsm-syntax" }`) by **design**, **amend_design**, **redesign**, **polish**, **replan** | the FSM DSL reference; NOT a standalone agent — a shared appendix |

## Conventions

- A prompt edits ONLY its declared artifacts and never the skeleton unless it is `design`/`redesign`/`replan`.
- `redesign` edits the **draft** (`reharness/.cache/scratch/draft-skeleton.xml`); `replan` edits the **compiled**
  skeleton (`reharness/skeletons/<id>.xml`) directly — different inputs, same `construct → fill → verify` chain.
- Keep prompts minimal and negative-rule-first ("NO X" beats "be consistent"); the build copies `*.md` to `dist/`.
