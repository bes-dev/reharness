## Why

reharness's runtime is deliberately provider-agnostic — the FSM, compiler, and watchdog treat an agent leaf as "someone runs it" — yet exactly one backend exists today: Pi (`src/runtime/providers.ts`, `REGISTRY = { pi: piProvider }`). The seam was designed so adding a backend is one Provider, not a cross-cutting change, but that claim is untested: several Pi-isms leaked across the seam (`piModel`/`piBinary` config names, a Pi-only install hint in the spawn error, `.pi.mjs`-only tool rendering). Adding a second and third backend now — OpenCode and NousResearch `hermes-agent` — proves the seam, generalizes the leaked names, and lets users run compiled pipelines on the agent CLI they already have.

## What Changes

- Add an **OpenCode provider** (`opencode`) supporting all three run modes: oneshot (`opencode run` JSON event stream), RPC (long-lived session for in-session validation), and interactive.
- Add a **Hermes provider** (`hermes`, NousResearch hermes-agent) supporting **oneshot and interactive only**; attempting RPC mode (a leaf with `validate`) fails loud with an actionable message.
- Generalize the leaked Pi-specific naming across the runtime seam: `piModel`/`piBinary` become backend-neutral (`model`/`binary`) with backward-compatible aliases, so existing pipelines and CLI flags keep working.
- Make the spawn-error install hint provider-aware (each Provider declares its own install instructions).
- Render synthesized-tool wrappers per backend at bind time for ALL registered providers (the existing `allProviders()` loop in `evolve.ts` already does this — the new providers supply their own `renderTool`; a backend with no plugin mechanism renders nothing, documented as a limitation).
- Register both providers in the `REGISTRY`; `--provider opencode|hermes`, `def.provider`, and `REHARNESS_PROVIDER` select them with no other code paths changed.

## Capabilities

### New Capabilities
- `agent-backends`: which agent CLI backends the runtime can spawn, how the three harness axes + model lower to each backend's argv, how each backend's event stream is normalized, which run modes each backend supports, and how backend-specific failures surface (missing binary, unsupported mode).

### Modified Capabilities
<!-- No existing specs under openspec/specs/ — nothing to modify. -->

## Impact

- **Code**: `src/runtime/providers.ts` (new providers, registry), `src/runtime/agent.ts` (provider-aware spawn error, neutral binary/model field names), `src/runtime/types.ts` and `src/runtime/fsm.ts` (`piModel`/`piBinary` → neutral names with aliases), `src/config.ts` (default provider comment), `src/cli.ts` (`--provider` help text).
- **Docs**: `README.md` backend section, `AGENTS.md` provider paragraph.
- **API**: no breaking changes — `piModel`/`piBinary` keep working as deprecated aliases; the `Provider` interface gains no required members.
- **Validation**: new unit tests for argv lowering + event normalization per provider; `--provider` resolution errors list all registered backends.
