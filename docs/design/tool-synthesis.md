# Design: Tool Synthesis — Generating an Agent's Tools, Not Just Its Prompt

Status: **draft / proposal** · Sibling of `harness-synthesis.md` (capability
binding) and the amortization rule (agent↔code). This is the **third level** of the
same idea.

---

## 0. The idea in one line

When an agent leaf's task contains a **mechanical sub-operation** (parse an xlsx,
run a specific diff algorithm, validate against a schema), the compiler should
**generate a deterministic tool** for it and give it to the agent — so the agent
*calls* the operation instead of *reasoning* it out. The agent keeps the judgement;
the mechanics become a zero-token tool call.

This makes reharness a compiler of the **full** "reasoning + tools" form, not just
"reasoning with default tools". Anything currently expressible as *an agent with
tools* becomes compilable, because we now compile **both halves**: the agent
(contract → prompt, already) **and its tools** (this document).

---

## 1. Why this is the same theory as amortization, one level down

The project already has one axis: **does this step need reasoning at all?**
(amortization, `agent ↔ code`). Tool synthesis is that exact axis applied **inside**
a leaf that, *as a whole*, does need reasoning.

| level | unit | the question | result |
|---|---|---|---|
| **L-node** (amortization, shipped) | a stage | is the *whole* step mechanical? | demote `agent → code`; the agent vanishes |
| **L-sub** (tool synthesis, this doc) | a sub-operation inside an agent | is a *part* mechanical, inside a reasoning step? | extract the part into a generated **tool**; the agent stays, but stops reasoning the mechanics |
| **L-bind** (harness, sibling doc) | the agent's environment | what external capability does it need? | bind/declare extensions/MCP |

This directly resolves the gap flagged in the nitpicker_v12 review:

> *render_report mixes 2 mechanical actions (render markdown, passthrough JSON) + 1
> judgement (infer change-intent). The node-level invariant "whole node is code or
> agent" forced the entire node to stay an agent because of the small judgement
> part.*

L-node amortization couldn't touch it (the node has irreducible judgement). **Tool
synthesis can:** generate `render_markdown_report(findings)` and
`validate_findings_schema(json)` as tools, leave the change-intent prose to the
agent's reasoning. Mechanics amortized, judgement preserved — *within* one node.

So the rule extends naturally:

> **Amortize whole mechanical steps to `code` nodes (L-node); amortize mechanical
> sub-operations of reasoning steps to generated `tools` (L-sub).** Same principle —
> spend reasoning only where it is irreducible — at two granularities.

A generated tool, like a `code` state, is **frozen reasoning**: authored once at
compile time, then invoked at zero marginal token cost at runtime. The difference is
*who* calls it: a `code` state is called by the runtime (we know the signature); a
**tool** is called by the LLM mid-turn (so it needs a self-describing schema, §4).

---

## 2. Generate vs bind vs discover — the three sources of a tool

Crucial distinction (the earlier confusion): a tool an agent needs can come from
three places, and they have very different cost/trust profiles.

| source | for what | who provides it | trust |
|---|---|---|---|
| **generate** (this doc) | mechanical skills: parse xlsx, custom algorithm, schema validation, format conversion | **the compiler writes the TS** | **ours** — same trust as generated lib code |
| **bind installed** | capability already present (`pi-web-utils`) | resolve from installed (`harness-synthesis.md`) | already trusted (operator installed it) |
| **external integration** | talk to a remote service (Jira, Postgres, Slack) | an MCP server / extension we cannot write (it's behind someone's API) | external; needs operator opt-in |

**Generation is the default and the common case.** Most "the agent needs a tool for
X" is a *mechanical skill*, and we can write it — no registry, no discovery, no
supply chain, because the code is **ours, synthesized**, exactly like the lib code of
a `code` state. Discovery/MCP is the **narrow residual**: only genuine external
integrations (a remote API we physically cannot synthesize) need an outside
capability, and those the operator installs; the compiler only *binds* them.

This is why the "search for some MCP" stage felt wrong: it was solving the *common*
case (mechanical skills) with the *rare* case's machinery (external discovery). Flip
it: **generate by default; bind installed where present; external only for true
integrations.**

---

## 3. Where it lives in the compiler

Tool synthesis is **per-leaf local** (a tool depends only on the leaf's contract,
like the harness — §harness-synthesis §1.0) and is decided by the same judgement
agent that already writes contracts.

### 3.1 design judges the tool boundary (one LLM decision, inline)

When `design` writes an agent leaf's `<contract>`, it also decides: *does this task
contain a mechanical sub-operation worth extracting into a tool?* Same judgement
shape as amortization condition (b) — and the same Rice-boundary reason it must be a
judgement, not a static rule (you cannot statically decide "this sub-task is a pure
function" from prose). Bounded output: the agent declares zero or more **tool specs**
on the node.

```xml
<state name="ingest_sheet" type="agent">
  <contract><![CDATA[ Read the uploaded .xlsx, extract the line-items table,
    then judge which rows are summary vs detail and tag them. ]]></contract>
  <tools>
    <tool name="parse_xlsx" effect="ReadWorkspace">
      <spec><![CDATA[ Input: {path: string}. Read the .xlsx at path; return
        {sheets: [{name, rows: string[][]}]}. Pure parse — no interpretation. ]]></spec>
    </tool>
  </tools>
  <on event="DONE" target="..." />
</state>
```

The agent's *prompt* will reason about summary-vs-detail (judgement); the *parsing*
is the generated `parse_xlsx` tool (mechanical). The design agent only extracts a
tool when the sub-op is genuinely mechanical — when in doubt, leave it in the prompt
(the same conservatism as amortization: a correct slow reasoning beats a wrong tool).

### 3.2 A generated tool spec is the same artifact class as a code state

A `<tool><spec>` is to a generated tool what a `<contract>` is to a generated `code`
state: a behavioural description the compiler lowers to real TS. `fill_prompts` (the
stage that already turns contracts into lib code) gains a sibling: turn each
`<tool><spec>` into a tool implementation. **Reuse the whole amortization machinery**
— a tool spec must be *mechanical over structured input*, exactly demotability (a)∧(b),
just scoped to a sub-operation.

---

## 4. Lowering: from `<tool>` to a Pi extension

Pi tool format (verified from the SDK + examples):

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function install(pi: ExtensionAPI) {
  pi.registerTool({
    name: "parse_xlsx",
    label: "Parse XLSX",
    description: "Read an .xlsx file and return its sheets as row arrays. Pure parse.",
    parameters: Type.Object({ path: Type.String({ description: "path to .xlsx" }) }),
    async execute(_id, params, _onUpdate, _ctx, _signal) {
      // synthesized deterministic body (uses a vendored xlsx lib or pure TS)
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
}
```

So the compiler generates, per leaf that declares tools, one extension file
`.reharness/tools/<state>-tools.ts`, and the runtime spawns that leaf with
`--extension <path>` (the harness lowering we already designed). Notes:

- **schema**: `<spec>` input shape → typebox `Type.Object`. Use `StringEnum` not
  `Type.Union` (Google API compat — from the docs). This is the one extra burden over
  `code`-state codegen: the params are LLM-facing, so the schema must be precise.
- **body**: synthesized like lib code (`fill_prompts` writes it). Pure/deterministic
  by construction — the demotability check forbids judgement inside a tool.
- **dependencies**: if the tool needs a library (xlsx parsing), the extension
  `package.json` carries it (Pi supports extension deps via jiti). Phase concern.
- **return**: `{content:[{type:"text",text}], details:{}}` — the tool returns its
  result as text the agent reads; `details` for non-LLM metadata.

The leaf's harness (`harness-synthesis.md`) and its generated tools compose: the
agent is spawned with `--extension <its generated tools>` **plus** any bound
installed capability, with the `--tools` allowlist = (generated tool names) ∪
(needed built-ins) ∪ (bound capability tools).

---

## 5. Static checks (correct-by-construction)

New lint/analysis instances, in the existing style:

- **tool determinism**: the generated tool body must satisfy demotability (a)∧(b) —
  mechanical over structured input; reuse the amortization check on the tool spec.
  A judgement smuggled into a tool is a compile error (it belongs in the prompt).
- **tool safety = effect inference over the generated code** (the Code Gate, now
  earning its place): the synthesized tool body's effects must be ⊆ the tool's
  declared `effect`. A tool declared `ReadWorkspace` that emits `child_process` is a
  compile error. This is exactly §harness-synthesis §6 (effects from source, exact,
  no Rice wall — we analyze code).
- **schema validity**: typebox params compile; tool names unique within the leaf and
  not colliding with built-ins.
- **referenced-in-prompt**: the agent's prompt must actually mention/use each
  generated tool (else dead capability — a warning, like an unused import).

---

## 6. Relation to Nous Hermes (studied)

Two Nous repos inform this, and both *validate the direction while differing in
method*:

- **hermes-agent** synthesizes "skills from experience" and lets the agent "write
  Python scripts that call tools via RPC, collapsing multi-step pipelines into
  zero-context-cost turns." That is exactly L-sub amortization (mechanics → callable
  code, zero reasoning tokens) — but done **at runtime, by the agent itself**
  (interpreter). reharness does it **at compile time, by the compiler** (compiler).
  Same insight; our form is static, analyzable, reproducible.
- **hermes-agent-self-evolution** is a working **GEPA-based** loop (read current →
  eval dataset → GEPA reads traces → variants → **constraint gates** (100% tests,
  size limits, semantic preservation) → best → **human PR**, no runtime
  self-modification). This is precisely the `evolve` contour we sketched, with two
  imports worth taking:
  - **GEPA** as the refine engine for prompts *and* tool specs (Phase 2 in their
    plan is literally "tool descriptions");
  - **constraint gates** as the concrete shape of our accuracy/measure stage
    (tests-pass + invariants + size/semantic), and **human-PR-not-autocommit** as
    confirmation of our "human approves, machine doesn't self-edit at runtime"
    invariant.

Takeaway: tool *synthesis* (this doc) is compile-time; tool *evolution* (GEPA over
tool specs from run traces) is the `evolve` loop's job later. Generation first,
evolution of the generated later — same split as everywhere.

---

## 7. Phasing

- **T0 — spec only, no deps.** Generate tools whose body is pure TS over built-in
  capability (string/JSON manipulation, custom diff, schema validation). No external
  libs. Smallest, covers a lot (the nitpicker render_report case is pure TS).
- **T1 — tools with vendored deps.** Allow the generated extension a `package.json`
  dependency (xlsx, etc.). Needs the deps-extension path of Pi.
- **T2 — tool determinism + safety lints** (§5), incl. the Code Gate as effect-⊆-declared.
- **T3 — bind installed capability** (`harness-synthesis.md` P3) — orthogonal, can interleave.
- **T4 — external integration via MCP** (the narrow residual) — only true remote APIs.
- **T5 — evolve tool specs via GEPA** (the `evolve` loop, with constraint gates à la Hermes).

T0 is the high-value core and is squarely our territory (codegen of deterministic TS
from a spec — we already do this for `code` states). Discovery/MCP (T4) is last and
narrow, as it should be.

---

## 8. Open questions

1. **Tool vs code-state boundary.** A mechanical sub-op could sometimes be a separate
   `code` state instead of a tool. Rule of thumb: if the agent needs to call it
   **adaptively, mid-reasoning, possibly multiple times with different args** → tool;
   if it's a fixed pipeline step → `code` state. Document the heuristic for `design`.
2. **Schema precision.** LLM-facing params are less forgiving than internal code.
   How much does `design`/`fill_prompts` need to nail the typebox schema? Start
   conservative (simple param shapes), let `evolve` refine descriptions (Hermes
   Phase 2).
3. **Dependency trust (T1).** A vendored npm dep in a generated tool is third-party
   code — but *we* chose it and it's pinned, unlike LLM-runtime discovery. Treat like
   any build dependency (lockable, reviewable in the generated artifact).
4. **Determinism of the tool body.** Enforce no clock/random/network unless the
   declared effect permits (the safety lint). A tool declared pure must be pure.
