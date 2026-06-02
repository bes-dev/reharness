# Implementation Plan: Per-Agent Harness Synthesis

Status: **draft / build plan** · Implements `harness-synthesis.md` (theory) and
`per-agent-harness.md` (lowering). This is the concrete, file-by-file plan.

Guiding facts (from the theory): harness is **local to a leaf** (depends only on its
contract), synthesis is **judge (effects) → deterministic lowering**, and it is
**sound for safety, incomplete for sufficiency** (sufficiency → `evolve`). All phases
are **opt-in and backward-compatible**: a leaf with no harness annotation spawns
exactly as today.

---

## 0. Data model (shared by all phases)

The leaf-local annotation the design agent produces is an **effect set**, plus the
declared economic fields. Everything else is derived deterministically from it.

```ts
// schema.ts — fixed effect alphabet (the only thing the agent may emit)
export type Effect =
  | "ReadWorkspace" | "WriteOwnOutput"   // role-default, always present for agents
  | "Shell" | "NetFetch" | "WebSearch" | "Git"   // external, judged from contract
  | `Mcp:${string}`;                              // external, parameterized by server

// schema.ts — what lands on a state (next to `contract`)
export interface HarnessDecl {
  effects?: Effect[];              // judged external effects (role-defaults implicit)
  model?: string;                  // declared (economic)
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";  // declared
  contextFiles?: boolean;          // false ⇒ --no-context-files
}
// SkeletonState gains:  harness?: HarnessDecl;
```

The author surface (`<harness>` in XML) is intentionally **effect-level**, not
flag-level: the agent declares *what it does* (`effects="NetFetch,WebSearch"`), the
compiler decides *which tools/extensions/flags* realize that (§2). This keeps the
declaration stable across Pi changes and enforces least-privilege by construction.

```xml
<state name="research" type="agent">
  <harness effects="WebSearch,NetFetch" model="sonnet" thinking="low" />
  <contract><![CDATA[ ... ]]></contract>
  <on event="DONE" target="outline" />
</state>
```

---

## 1. The registry & affordance map (`src/compiler/harness/registry.ts`, new)

Two small fixed tables + a tiny cover solver. Pure, no I/O beyond reading the
project capability map.

```ts
// affordance: Effect → required tool names
const AFFORD: Record<string, string[]> = {
  ReadWorkspace:  ["read", "ls", "grep", "find"],
  WriteOwnOutput: ["write", "edit"],
  Shell:          ["bash"],
  NetFetch:       ["fetch_webpage"],
  WebSearch:      ["web_search"],
  Git:            ["clone_github_repo", "search_local_repo"],
  // Mcp:<server> resolved via the capability registry (tools enumerated there)
};
const BUILTIN = new Set(["read","ls","grep","find","write","edit","bash","glob"]);

// capability registry: capability id → { tools, extensionPath?, skillPath? }
// seed: pi-web-utils provides fetch_webpage, web_search, clone_github_repo, search_local_repo
interface Capability { id: string; tools: string[]; extensionPath?: string; skillPath?: string; }

export interface SynthHarness {
  tools: string[];          // exact least-privilege allowlist (T)
  extensions: string[];     // resolved extension paths (cover X*)
  skills: string[];
  model?: string;
  thinking?: string;
  noContextFiles: boolean;
  errors: string[];         // resolution/validity failures → lint
}

export function synthesizeHarness(h: HarnessDecl | undefined, caps: Capability[]): SynthHarness | null;
// null ⇒ no <harness> ⇒ caller spawns exactly as today (backward compat).
```

Algorithm (mirrors `harness-synthesis.md` §5):
1. `E = {ReadWorkspace, WriteOwnOutput} ∪ (h.effects ?? [])`.
2. `T = ⋃ AFFORD[e]` (Mcp:* tools from registry).
3. `Tx = T \ BUILTIN`.
4. `X* = minCover(Tx, caps)` — brute force over `caps` (registry is tiny); greedy fallback.
5. resolve `X*` → extension/skill paths.
6. emit `SynthHarness`; push errors for: unknown effect, tool with no providing capability, unknown Mcp server.

**Capability map source (Q1 resolved conservatively):** start with a built-in seed
(`pi-web-utils` → its 4 tools + its installed path), overridable by an optional
`.reharness/harness.json`. No premature config; grows when real MCP servers appear.

---

## 2. Static checks (`src/compiler/analysis/` — extend)

New lint-level instances (powerset-membership, not fixpoints — consistent with the
analyzer's "every check is an instance" rule):

- **harness placement**: `<harness>` only on `agent`/`interactive`; error on code/structural.
- **effect validity**: every `effects` entry ∈ alphabet (or `Mcp:<known>`).
- **resolution**: every required tool is afforded by some capability (else "contract
  asks for effect X but no installed capability provides it" — a real compile error,
  the harness analogue of `configFlowErrors`).
- **enum validity**: `thinking` ∈ set; `model` non-empty if present.

These run in `construct` (skeleton-level) alongside lint/semantic. `synthesizeHarness`
returning `errors` feeds them.

---

## 3. Lowering: codegen (`src/compiler/codegen.ts`, `agentOpts`)

`agentOpts` currently emits `{ model?, inputs?, inputLists? }`. Extend it: call
`synthesizeHarness(state.harness, caps)` and merge the result into the emitted opts
object. New emitted fields (only when present): `tools`, `extensions`, `skills`,
`thinking`, `noContextFiles`. `model` precedence (Q4): `modelExpr` > `harness.model`
> pipeline default — already an IIFE, so thread `harness.model` as the fallback
inside `(m) => ...`.

No change to the `branch`/`join`/`step`/plain dispatch — harness is orthogonal to role.

---

## 4. Lowering: runtime (`src/runtime/types.ts` + `src/runtime/agent.ts`)

`AgentOpts` gains: `tools?: string[]; extensions?: string[]; skills?: string[];
thinking?: string; noContextFiles?: boolean;` (model already present).

`agent.ts` builds `args` in **three** spawn paths (`runAgent` JSON, `runAgentRpc`
RPC, `runInteractive`). Factor a single helper to avoid drift:

```ts
function harnessArgs(o?: AgentOpts): string[] {
  const a: string[] = [];
  if (o?.thinking) a.push("--thinking", o.thinking);
  if (o?.tools?.length) a.push("--tools", o.tools.join(","));
  for (const e of o?.extensions ?? []) a.push("--extension", e);
  for (const s of o?.skills ?? []) a.push("--skill", s);
  if (o?.noContextFiles) a.push("--no-context-files");
  return a;
}
```
Splice `...harnessArgs(o)` into each `args` array after the existing
`--model`/`--system-prompt`. `model` stays handled as today (`o?.model || piModel`).
**Backward compat: `harnessArgs(undefined) === []`** → no harness ⇒ identical spawn.

---

## 5. XML (`src/compiler/xml.ts`)

Parse/serialize `<harness>` as a self-closing element on a state, attributes:
`effects` / `skills` (comma-lists), `model` / `thinking` (strings), `context-files`
(`off`→`contextFiles:false`). Same mechanical pattern as `<inputs>` (`isArray`,
attribute mapping, round-trip). Add `"harness"` handling; no array-of-children needed
(single element per state).

---

## 6. The author/agent surface (`src/compiler/agents/*.md`)

- `_fsm-syntax.md`: add a short `<harness>` section — the effect alphabet, that it is
  **local** (depends only on this node's task), and that the compiler turns effects
  into least-privilege tools. Emphasize: *declare an effect only if the contract
  truly needs it; default is none → built-in tools only after P2*.
- `design.md`: one rule, inline (like amortization) — "for each agent leaf, judge its
  external effects from its contract and emit `<harness effects=...>`; pick
  `model`/`thinking` by task difficulty." No new pass, no extra tokens.

---

## 7. Output validator (P0, independent — `opts.validate`)

Separable and shippable first. From a leaf's declared outputs (parseable from the
contract's "writes X.json" or, more robustly, a structured `produces`-free heuristic:
the files named in the contract), codegen synthesizes a `validate` closure:
```ts
validate: () => { const errs=[]; /* each declared output exists + JSON.parse if .json */ return errs; }
```
The runtime already runs `validate` via the RPC re-prompt loop (`runAgentRpc`). First
version: **file-existence + JSON-parse** of outputs the contract names; no schema. This
is the structural half of an accuracy check, available at compile-once with no oracle.

---

## 8. Build order (each shippable, each backward-compatible)

| Phase | Deliverable | Files | Risk |
|---|---|---|---|
| **P0** | output validator | codegen, agent.ts (wire existing `validate`) | low; no author surface |
| **P1** | economic harness: `model` + `thinking` | schema, xml, codegen, types, agent.ts | low; pure flags |
| **P2** | effect→tools least-privilege allowlist | + harness/registry.ts, analysis checks | med; opt-in avoids breakage |
| **P3** | capability binding (extensions/skills, incl. MCP) | + registry resolution, capability map | med; needs real cap map |
| **P4** | per-leaf extension *generation* | new codegen of a Pi extension module | high; defer; needs ExtensionAPI types |

P0 and P1 touch no new theory and give immediate value (self-correction; per-leaf
cost/quality). P2 is where least-privilege/effect-inference lands. P3 is capability
binding. P4 (generating bespoke extensions) is the far goal.

---

## 9. Tests (extend the `node:test` suite)

- `harness/registry.test.ts`: `synthesizeHarness` — effect set → exact tools; minimal
  cover picks fewest extensions; unknown effect/unresolvable tool → error; no harness → null.
- `codegen.test.ts`: an agent state with `<harness>` emits `tools`/`extension` opts;
  without it, emits today's opts (regression guard, like the `<inputs>` test).
- `agent` arg-builder: `harnessArgs(undefined) === []`; full opts → expected flag list.
- xml round-trip for `<harness>`.
- (P0) validator: declared JSON output missing/invalid → non-empty errors.

---

## 10. Open questions (carried, with defaults)

1. **Capability map location** — default: built-in seed + optional `.reharness/harness.json`.
2. **How much design *derives* vs leaves to human** — default: judge external effects
   from contract; `model`/`thinking` declared. Re-evaluate via evolve signal.
3. **Least-privilege default** — keep **opt-in** (no harness ⇒ full default tools)
   until contracts reliably declare effects; flipping the default is a later, deliberate
   version bump + a run to confirm.
4. **`model-expr` vs `harness.model`** — precedence `model-expr > harness.model > default`.
5. **`context-files` default for leaves** — leave as-is for now (opt-in `off`); flipping
   the global default to `off` for leaves is a behavioural change, gate behind a bump.
