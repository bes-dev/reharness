# Design: OpenCode + Hermes provider adapters

## Context

The runtime driver (`src/runtime/agent.ts`) is already generic: it spawns a CLI, parses newline-delimited JSON events through `provider.normalize()`, and frames RPC turns via `provider.frame()`. Everything backend-specific sits behind the `Provider` interface in `src/runtime/providers.ts` (`args` / `normalize` / `frame` / `renderTool` / `binary` / `name`). Only `piProvider` is registered. A few Pi-isms leaked across the seam: `piModel`/`piBinary` field names, a Pi-only install hint in `spawnError`, and `.pi.mjs` as the only synthesized-tool rendering.

Target backends:
- **OpenCode** (`opencode` CLI): supports all three modes — `opencode run` for headless oneshot with a JSON event stream, a long-lived mode usable for RPC turn-framing, and terminal-interactive use.
- **Hermes** (NousResearch `hermes-agent`): oneshot + interactive only; no documented RPC/stdin multi-turn mode. A leaf with `validate` on `hermes` must fail loud before spawning.

## Goals / Non-Goals

**Goals**
- Register `opencode` and `hermes` providers; every existing selection point (`--provider`, `def.provider`, `REHARNESS_PROVIDER`) works for them unchanged.
- De-Pi the seam: neutral `model`/`binary` naming with `piModel`/`piBinary` kept as working aliases; `spawnError` install hint comes from the Provider.
- Fail loud, before spawn, when RPC/validation is requested on a backend without RPC support.
- Unit-test argv lowering + `normalize` per provider (fixture JSONL streams; no live CLIs).

**Non-Goals**
- No changes to FSM semantics, watchdog, retry, resume, or cost accounting — the driver is untouched except the provider-aware error and neutral names.
- No live end-to-end tests against real `opencode`/`hermes` binaries in CI (they may not be installed); smoke is manual.
- No MCP/plugin tool synthesis for backends without a plugin mechanism — `renderTool` may legitimately return `[]` (already the interface contract).

## Decisions

### 1. One module per provider family stays in `providers.ts`
`providers.ts` grows `opencodeProvider` and `hermesProvider` next to `piProvider`, and `REGISTRY = { pi, opencode, hermes }`. The file is the designated "one seam" — splitting into three files now buys nothing and scatters the pattern a fourth backend should copy. Revisit only if a provider's normalize/prompt-shaping logic gets large.

*Alternative considered:* one file per provider — rejected as premature; the header comment already advertises this file as the single adapter point.

### 2. Extend the `Provider` interface with optional, not required, members
Add two optional fields, both defaulted in the driver, so existing/third-party Providers keep compiling:
- `installHint?: string` — used by `spawnError` instead of the hard-coded Pi text (Pi's current hint moves onto `piProvider`).
- `modes?: readonly AgentMode[]` (default all three) — `hermes` declares `["oneshot", "interactive"]`. `runAgent` checks `config.validate` against `provider.modes` before spawning and throws: `Backend 'hermes' does not support RPC/validation mode (supported: oneshot, interactive). Use --provider pi or opencode for leaves with validate.`

*Alternative considered:* make `frame()`/`args("rpc")` throw — rejected; the error would surface only after process setup instead of as a clean pre-flight failure, and a declared mode set is self-documenting for `--help` text later.

### 3. Neutralize `piModel`/`piBinary` via aliases, not renames
`AgentRunConfig`, `PipelineDefinition`, and `RunOptions` gain `model?: string` / `binary?: string`; the runtime resolves `model = c.model ?? c.piModel` (and same for binary). CLI `--model` keeps its flag name (it's already backend-neutral in effect). Docs (`AGENTS.md`, README) switch to the neutral names; the old names remain accepted indefinitely — they are part of the public definition surface used by generated commands.

*Alternative considered:* rename outright — rejected; breaks every generated command's `def.piModel` in user repos for zero runtime gain.

### 4. Normalize each backend's events behind its own `normalize()`, mapping what exists
OpenCode's JSON stream (`opencode run --print-logs`-style event lines) and Hermes's headless output each get a dedicated `normalize` mapping onto the existing `NormEvent` vocabulary. Events with no counterpart (backend-specific acks/UI) map to `[]`, per the established pattern. If a backend cannot report per-message cost, its `usage` events carry tokens only and `costUSD: 0` — the verdict then shows $0 for that backend, documented, never estimated.

*Alternative considered:* stretching `NormEvent` to fit richer backends — rejected; the vocabulary is deliberately the smallest common denominator, and widening it for one backend complicates the shared driver.

### 5. Tool synthesis degrades honestly per backend
The bind-time loop in `evolve.ts` already renders for `allProviders()`. OpenCode gets a `renderTool` producing its plugin variant (concrete format settled in implementation against OpenCode's plugin docs). Hermes has no documented external-tool plugin mechanism; `renderTool` returns `[]` and its extension lowering passes hand-written refs through with its native flag or, if none exists, drops them with a `ctx.warn`-level degradation note — never a silent no-op, never a hard failure.

## Risks / Trade-offs

- [Backend stream formats drift from the fixtures] → `normalize` tests are fixture-based per provider; a drift breaks only that provider's parsing (events fall through to `[]`), not other backends, and surfaces as missing activity lines rather than wrong control flow.
- [`hermes` users hit the RPC wall mid-pipeline] → the `modes` check fails *before* spawn with a redirect message; documentation marks `hermes` as validation-incompatible up front.
- [OpenCode RPC turn framing differs from Pi's prompt/agent_end shape] → isolated behind `frame()`/`normalize()`; the RPC driver (`runAgentRpc`) only depends on `turn_end` arriving, which the OpenCode adapter maps from its stream's completion event.
- [Alias duality (`model` vs `piModel`) confuses] → exactly one precedence rule (`model ?? piModel`), documented in types' doc comments; no config location accepts both simultaneously without the precedence note.

## Migration Plan

Purely additive: default provider remains `pi`; existing definitions, generated commands, and CLI invocations behave byte-identically. No data migration. Rollback = revert; no persisted artifacts change shape (run state stores no provider-specific data beyond strings already filtered through `NormEvent`).

## Open Questions

None blocking. Exact flag spellings for OpenCode's headless/RPC modes and Hermes's headless output format are pinned down during implementation against the installed CLIs' `--help`/docs; the adapter structure absorbs any spelling without design change.
