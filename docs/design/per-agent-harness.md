# Design: Per-Agent Harness Generation

Status: **draft / proposal** · Target: reharness ≥ v0.26 · Owner: TBD

## 1. Problem & framing

Today every generated agent leaf is spawned with the *same* minimal harness:
`runAgent` (`src/runtime/agent.ts`) hardcodes exactly four `pi` flags —
`--mode`, `--no-session`, `--model`, `--system-prompt` (+ optional
`--append-system-prompt`). An agent is therefore **a system prompt + Pi's default
tool set**, identical for a one-line JSON reformatter and a security reviewer.

This under-uses Pi. Pi exposes the *entire* agent configuration as per-process CLI
flags (see §3). Each leaf is its own `pi` process, so each leaf could carry its own
harness — model, thinking budget, an *enforced* tool allowlist, extensions/MCP/skills,
context hygiene, and an output validator.

### What this is — and what it is NOT

A `<contract>` says **what** a node does (behaviour). A harness says **with what**
it does it (capability/environment). These are **orthogonal axes**:

- **Amortization** (already shipped) acts on *whether reasoning is needed at all*
  (`agent` ↔ `code`). It *removes* an agent where reasoning is reducible.
- **Harness** acts on *how the reasoning that remains is equipped*. It *equips* the
  agent that stays.

After amortization, only irreducible-reasoning leaves remain — exactly the ones
worth equipping well, since we already pay for the LLM call.

### Relation to "Compiled AI"

Compiled AI (Trooskens et al.) hand-built **one** safe harness for **one** coding
agent, tuned it, and reported metrics. This feature makes harness generation a
**compiler pass**: the compiler emits a tailored harness **per leaf, automatically,
from the contract**. Their entire paper is one manual instance of what this pass
produces in bulk. There is nothing to import from them here — the per-leaf,
auto-generated framing is strictly more general.

## 2. Goals / non-goals

**Goals**
- G1. Let each agent leaf declare/derive a harness; lower it to per-process `pi` flags.
- G2. Least-privilege by construction: a leaf gets only the tools it needs (enforced, §3).
- G3. Economic control: per-leaf model + thinking budget (heavy+high for hard judgement, light+low for shallow work).
- G4. Capability binding: per-leaf web/MCP/skill access, only where the contract needs it.
- G5. Output self-correction: emit `opts.validate` from the contract (the runtime mechanism already exists).
- G6. Honor the project laws: derive the derivable, declare the irreducible; no new declared-dataflow layer; decisions to states/agents, not glue.

**Non-goals (for the first cut)**
- N1. Generating *new* Pi extensions per leaf (only bind existing ones). [future]
- N2. Anything requiring changes to Pi itself.
- N3. Runtime/behavioural validation of harness choices (that's the `evolve` loop, via the external compile→run→evolve cycle).

## 3. Pi capability surface (verified, v0.75.5)

Each leaf is one `pi` process; the harness is flags on it. All verified via
`pi --help` and live tests (see [[pi-harness-surface]] memory).

| Axis | Pi flag(s) | Notes |
|---|---|---|
| system prompt | `--system-prompt`, `--append-system-prompt` (repeatable) | already used |
| model | `--model provider/id[:thinking]` | already used (`opts.model`) |
| thinking budget | `--thinking off\|minimal\|low\|medium\|high\|xhigh` | **not yet used** |
| tool allowlist | `--tools a,b,c`, `--no-tools`, `--no-builtin-tools` | **ENFORCED** — `--tools read,ls` physically blocked a write in test. Applies to built-in + extension tools. |
| extensions (capabilities) | `--extension <path>` (repeatable), `--no-extensions` | extension = TS module `export default (pi:ExtensionAPI)=>{ pi.registerTool(...) }` |
| MCP | *(none of its own)* | MCP is wired **through an extension** → "MCP per-agent" = "extension per-agent" |
| skills | `--skill <path\|dir>`, `--no-skills` | |
| prompt templates | `--prompt-template <path>`, `--no-prompt-templates` | |
| context hygiene | `--no-context-files` | disables AGENTS.md/CLAUDE.md discovery |
| session isolation | `--no-session` | already used |

All axes are orthogonal and compose with our existing `--mode json/rpc --no-session
--system-prompt` (verified together). There is **no** `--agent` flag — Pi has no
named-agent concept; an "agent" *is* a set of flags. Config dir is `~/.pi/agent/`.

## 4. Author surface: the `<harness>` element

A new optional child on `agent` / `interactive` states. Absent ⇒ today's behaviour
(unchanged), so this is backward-compatible and opt-in.

```xml
<state name="security_review" type="agent">
  <harness model="anthropic/claude-opus-4-8" thinking="high"
           tools="read,grep,find"
           capabilities="web"
           context-files="off" />
  <contract><![CDATA[ ... ]]></contract>
  <on event="DONE" target="merge" />
</state>
```

### Attributes (first cut)

| Attr | Meaning → lowers to | Derive vs declare |
|---|---|---|
| `model` | `--model` | **declare** (economic judgement) — overrides pipeline default |
| `thinking` | `--thinking <level>` | **declare** (judgement) |
| `tools` | `--tools <list>` (allowlist) | **derivable hint** from contract verbs; declarable to tighten |
| `no-builtin-tools` | `--no-builtin-tools` | declare (rare) |
| `capabilities` | resolve names → `--extension <path>` (and skill paths) | **derivable** from contract ("fetch pages" → web); declarable |
| `skills` | `--skill <path>` | declare |
| `context-files` | `off` → `--no-context-files` | declare; **default `off` for leaves** (see §7) |

### Derive vs declare (the project law)

- **Derive** what the contract implies: if the contract says "search the web" /
  "clone a repo", the design agent can infer `capabilities="web"`. Tool allowlist can
  be inferred conservatively from contract verbs (reads files → `read`; writes → `write`).
- **Declare** the irreducible judgement: `model` and `thinking` are
  cost/quality choices with no internal source to derive from (same status as
  `<inputs>` — external/economic). They are declared on the node.

Realization mirrors amortization (level A): the **design** agent fills `<harness>`
inline, in the same pass, from the contract — **no extra compiler stage, no extra
tokens**. `_fsm-syntax.md` + `design.md` get a short section teaching the element.

## 5. Lowering (compiler + runtime)

### 5.1 Schema (`src/compiler/schema.ts`)
Add `harness?: HarnessDecl` to `SkeletonState`:
```ts
export interface HarnessDecl {
  model?: string;
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";
  tools?: string[];            // allowlist
  noBuiltinTools?: boolean;
  capabilities?: string[];     // logical names → resolved to extension/skill paths
  skills?: string[];           // explicit skill paths/names
  contextFiles?: boolean;      // false → --no-context-files
}
```

### 5.2 XML (`src/compiler/xml.ts`)
Parse/serialize `<harness .../>` (attributes; `tools`/`capabilities`/`skills` are
comma-lists). Round-trip, same pattern as `<inputs>`.

### 5.3 Capability registry
A logical name (`web`, `git`, …) must resolve to a concrete extension/skill path.
Source of truth = a small map the compiler reads (e.g. from project
`.reharness/harness.json` or Pi's installed packages). Unknown capability →
**lint error** (a config-flow-style check: every `capabilities` name must resolve).
This keeps it correct-by-construction, like `configFlowErrors`.

### 5.4 Codegen (`src/compiler/codegen.ts`, `agentOpts`)
`agentOpts` currently emits `model` + `inputs`/`inputLists`. Extend the emitted
`AgentOpts` with a `harness` object carrying the lowered fields (model already there;
add thinking/tools/extensions/skills/contextFiles). Resolve `capabilities` →
extension paths at codegen time.

### 5.5 Runtime (`src/runtime/agent.ts`, `AgentOpts`, all three spawn paths)
`AgentOpts` gains the harness fields. `runAgent`/`runAgentRpc`/`runInteractive`
build the arg list from them:
```ts
if (o.thinking) args.push("--thinking", o.thinking);
if (o.tools?.length) args.push("--tools", o.tools.join(","));
if (o.noBuiltinTools) args.push("--no-builtin-tools");
for (const e of o.extensions ?? []) args.push("--extension", e);
for (const s of o.skills ?? []) args.push("--skill", s);
if (o.contextFiles === false) args.push("--no-context-files");
```
`model` already handled. Backward-compatible: no harness ⇒ no extra flags.

### 5.6 Output validator (G5) — separable sub-feature
Independent of `<harness>`: from the contract, codegen can synthesize an
`opts.validate` closure (e.g. "the named output file exists and is valid JSON").
The runtime already runs `validate` via the RPC re-prompt loop. Can ship before or
after the harness element. Conservative first version: file-existence + JSON-parse
of declared outputs.

## 6. Static checks (correct-by-construction)

New analyzer instances (in the spirit of Table 4 of `docs/reharness.tex`):
- **capability resolution**: every `capabilities`/`skills` name resolves to an
  installed extension/skill path; else lint error. (Mirrors `configFlowErrors`:
  used ⊆ available.)
- **tool name validity**: `tools` entries are known built-in or extension tool names.
- **thinking/model enum**: `thinking` ∈ the allowed set; `model` non-empty.
- **harness only on agent/interactive**: lint error on a harness under code/structural states.

These are grammar/lint-level (powerset-membership), not new fixpoints — consistent
with "every check is an instance of a standard analysis".

## 7. Defaults & policy

- **Least-privilege default is appealing but risky.** Pi's default tool set is broad;
  switching leaves to "deny by default" could silently break agents that relied on an
  unlisted tool. **First cut: opt-in.** No `<harness>` ⇒ unchanged (full default
  tools). A leaf tightens explicitly. A future policy flag could flip the default to
  least-privilege once contracts reliably declare their tools.
- **`context-files` default for leaves should be `off`.** A generated leaf has its
  own system prompt; pulling the *project's* AGENTS.md/CLAUDE.md into a leaf is
  usually noise. Consider defaulting leaves to `--no-context-files` even without a
  `<harness>` — but that is a behavioural change; gate it behind a deliberate version
  bump and a run to confirm.

## 8. Phasing

- **P0 — output validator (G5).** Smallest, independent, high value: structural
  self-correction with zero new author surface. Synthesize `opts.validate` from
  declared outputs; wire into codegen.
- **P1 — economic harness (G3).** `<harness model thinking>` + lowering. Cheapest
  *new* surface, immediate cost/quality control, no capability registry needed.
- **P2 — tool allowlist (G2).** Add `tools`/`no-builtin-tools` + the tool-name lint.
  Least-privilege, enforced.
- **P3 — capability binding (G4).** `capabilities`/`skills` + the resolution registry
  + lint. Bind existing extensions/MCP/skills per leaf.
- **P4 — extension generation (N1→goal).** Generate a bespoke Pi extension per leaf
  from the contract. Largest; needs the `ExtensionAPI` typebox shape. Defer.

Each phase is independently shippable and backward-compatible.

## 9. Open questions

1. Capability registry location: project file (`.reharness/harness.json`) vs reading
   Pi's installed `settings.json` vs a fixed built-in map. Start with a small built-in
   map (`web` → pi-web-utils path) to avoid premature config.
2. How much of `tools`/`capabilities` should `design` *derive* vs leave to a human?
   Start derive-conservative (only the obvious), declare the rest. Re-evaluate after a
   few runs (candidate signal for `evolve`).
3. Should `verify` smoke-test that a harnessed leaf's flags are accepted by `pi`
   (dry parse) without a real LLM call? Cheap guard against a bad flag reaching runtime.
4. Interaction with `model-expr` (dynamic per-branch model): `<harness model>` is
   static; `model-expr` is dynamic. Precedence: `model-expr` > `<harness model>` >
   pipeline default. Document it.

## 10. Risks

- **Pi version drift.** Flags are from v0.75.5 `--help`; pin/check on a Pi bump.
  The `ExtensionAPI` shape (P4) is from one example (pi-web-utils) — verify against
  `@mariozechner/pi-coding-agent` types before P4.
- **Silent capability gaps.** A leaf denied a tool it actually needed fails at
  runtime, not compile time. Mitigation: keep opt-in (P0–P2), and the tool/capability
  lints catch *misspelled* names (not *missing-but-needed* ones — that's evolve's job).
- **Over-tuning.** Per-leaf model/thinking is a knob the design agent could mis-set.
  Mitigation: conservative defaults; treat harness choices as a future evolve target.
