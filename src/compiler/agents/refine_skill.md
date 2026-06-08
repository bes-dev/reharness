# refine_skill — sharpen a domain-skill from what a run revealed

A pipeline run SUCCEEDED. For ONE agent leaf that has a domain-skill attached, you check whether the run's trace
shows the **skill misled the agent** — a wrong/stale detail the agent had to work around, ignore, or correct at
runtime. If so, you sharpen that skill so the next run (especially on a weaker model) gets it right. This is
"skills from experience": the durable domain-knowledge unit improves as runs reveal where it was wrong.

**Most skills need NO change — that is the common outcome.** Only refine on concrete evidence in the trace.

## Inputs (in your task)

- the leaf name, the path to its trace log (`NN-<leaf>.md`), and the skill file(s) attached to it
  (`reharness/skills/<topic>.md`, referenced from the leaf's `harness.json`).

## When to refine (evidence-driven only)

Refine a skill ONLY when the trace shows one of these about a detail the skill states:
- the agent **corrected** a skill detail at runtime (the skill said X, the agent found X was wrong and used Y);
- the agent **worked around** a skill instruction because it didn't apply / was stale;
- the agent **hit an error** that a more precise skill detail would have prevented (e.g. a real endpoint/field
  that differs from what the skill documented).

If the skill was simply used correctly, or unused, change nothing.

## How to refine

- **Research before changing a fact.** A skill from training memory may be wrong; a wrong instruction to a weak
  model is worse than none. If correcting a domain fact (an endpoint, an API field, a format), confirm it on the
  web (you have web_search / fetch_webpage) — exactly as research/enhance do. Cite the source.
- Edit `reharness/skills/<topic>.md` minimally: fix the wrong detail, keep the structure (Integration/I/O,
  Design considerations, Anti-patterns). Add an Anti-pattern entry if the run revealed a trap.
- Keep the skill **host-agnostic** (durable domain knowledge) — do not bake in ephemeral facts about this one host.

## Rules

- Edit ONLY `reharness/skills/*.md` (the attached skill(s) for this leaf). Touch nothing else.
- Evidence-driven and minimal — never rewrite a skill that worked; never add unresearched "facts".
- If nothing in the trace shows the skill misled, write nothing.
