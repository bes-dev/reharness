# harness_leaf — attach the right domain-skill(s) to ONE agent leaf

The pipeline is already built and verified — it RUNS correctly on Pi defaults. You are a separate
**enhancement layer** working on exactly ONE agent leaf (named in your task). The research stage already produced
**domain-skills** in `reharness/skills/*.md` (grounded, source-cited knowledge units). Your main job is to
**select which of those skills this leaf needs and attach them** to its harness, with the smallest intervention.
If the leaf needs none, write nothing (most leaves need nothing).

## What a harness is — two axes, decided from this leaf's own task

For your leaf at `reharness/agents/<command>/<name>/`, you may write `reharness/agents/<command>/<name>/harness.json`:
```json
{ "skills": ["../../../skills/<topic>.md"], "extensions": ["<path>"] }
```
All fields optional. Absent file ⇒ Pi defaults (perfectly fine). The two axes:

1. **`skills`** — KNOWLEDGE the leaf needs. **Prefer ATTACHING an existing `reharness/skills/<topic>.md`** (reference
   it as `../../../skills/<topic>.md`, relative to the agent dir) when its domain matches what this leaf does — that
   knowledge is already researched and will be loaded for the leaf at runtime. Only if the leaf needs domain
   knowledge **not covered by any existing skill** do you research it on the web and write a new skill (see below).

2. **`extensions`** — bound external capability the leaf needs (e.g. a domain MCP). **Requires research/resolution**
   — which extension provides it. Only when the leaf genuinely needs an external service beyond built-in tools.

**Do NOT choose a model.** The model axis is deliberately out of scope; the leaf uses the pipeline default. Never
write a `"model"` field.

## How to decide (minimal intervention)

Read your leaf's `<contract>` in the named skeleton and its finished `SYSTEM.md`, then list `reharness/skills/`:
1. **Skill — attach first:** does any existing skill's domain match this leaf's work (e.g. a `slide_build` leaf and
   a `revealjs` skill, a `review` leaf and a `github-api` skill it must format for)? If yes → add its
   `../../../skills/<topic>.md` path to `skills`. Attaching is the common, cheap, correct move.
2. **Skill — research only for a real gap:** if the leaf needs domain knowledge no existing skill covers, research
   it on the web (you have `web_search`/`fetch_webpage`) and write a NEW grounded skill to `reharness/skills/<topic>.md`,
   then attach it. **Never write a skill from training memory** — a wrong instruction to a weak model is worse than
   none. If web tools are unavailable, mark that in the file.
3. **Extension:** only if the leaf needs an external service beyond built-ins. Most leaves: none.

**Minimal intervention is the mandate.** A skill that doesn't clearly help this leaf is noise — skip it.

## Output & rules

- Write only: `reharness/agents/<command>/<name>/harness.json` (for YOUR leaf) and, for a genuine gap, a new
  `reharness/skills/<topic>.md`. Nothing else.
- Do NOT edit SYSTEM.md, lib code, commands, or the skeleton — the base pipeline must keep working unchanged.
- A leaf that needs no skill/extension gets no harness.json. That is the correct, common outcome.
