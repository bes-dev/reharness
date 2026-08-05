# Tasks: OpenCode + Hermes provider adapters

## 1. Provider interface groundwork (`src/runtime/providers.ts`)

- [x] 1.1 Extend the `Provider` interface with optional `installHint?: string` and `modes?: readonly AgentMode[]` (default all three), documenting both in the header comment
- [x] 1.2 Move Pi's install hint from `agent.ts:spawnError` onto `piProvider.installHint`
- [x] 1.3 Pin the exact OpenCode CLI flags/event shapes from the installed `opencode --help` (or its docs) and the Hermes headless output format from `hermes --help`/docs; record findings in the provider comments

## 2. OpenCode provider (`src/runtime/providers.ts`)

- [x] 2.1 Implement `opencodeProvider.args` for oneshot / rpc / interactive, lowering model, system prompt, append prompt, skills, and extensions to OpenCode's native flags
- [x] 2.2 Implement `opencodeProvider.normalize` mapping OpenCode stream events to `NormEvent` (tool start/end, text, thinking, usage incl. cache fields where available, turn end)
- [x] 2.3 Implement `opencodeProvider.frame` for RPC turn framing, verifying a framed turn produces a normalizable `turn_end` event
- [x] 2.4 Implement `opencodeProvider.renderTool` for the synthesized-tool plugin variant (or return `[]` with a comment if no viable plugin mechanism)
- [x] 2.5 Register `opencode` in `REGISTRY`

## 3. Hermes provider (`src/runtime/providers.ts`)

- [x] 3.1 Implement `hermesProvider` with `modes: ["oneshot", "interactive"]`: `args` for both modes (model/prompt/task lowering), `normalize` for its headless event output, and an `installHint`
- [x] 3.2 Define Hermes behavior for `renderTool` and extension lowering: pass hand-written refs through with the native flag if one exists, else return `[]` / drop with a documented degradation note — never silent
- [x] 3.3 Register `hermes` in `REGISTRY`

## 4. Runtime seam de-Pi-ing (`src/runtime/agent.ts`, `types.ts`, `fsm.ts`)

- [x] 4.1 `spawnError` uses `provider.installHint` (fallback: generic install message) instead of the hard-coded Pi text
- [x] 4.2 `runAgent` checks `config.validate` against `provider.modes` before spawning and throws the actionable RPC-unsupported error (spec: Validation on Hermes fails loud)
- [x] 4.3 Add `model?: string` / `binary?: string` to `AgentRunConfig`, `PipelineDefinition` (`types.ts`), and `RunOptions`; resolve `model ?? piModel` and `binary ?? piBinary` at each use site in `fsm.ts` and `agent.ts` with the precedence documented in doc comments
- [x] 4.4 Update `config.ts` PROVIDER comment and `cli.ts` `--provider` help text to name all registered backends

## 5. Tests

- [x] 5.1 Add a providers test file: argv lowering snapshots per provider per mode (pi/opencode/hermes × oneshot/rpc/interactive), incl. model, append-prompt, skills, and routine-extension lowering
- [x] 5.2 Fixture-based `normalize` tests per provider: recorded JSONL event lines → expected `NormEvent[]` (tool lifecycle, usage with cache fields, turn end)
- [x] 5.3 Test `resolveProvider` error lists all registered backends; test `hermes` RPC rejection in `runAgent` (validate set → pre-spawn throw) and `spawnError` carrying the provider's install hint
- [x] 5.4 Run the full test suite (`npm test`) and typecheck (`npx tsc --noEmit`)

## 6. Docs

- [x] 6.1 Update `AGENTS.md` provider paragraph: three backends, neutral `model`/`binary` names (with alias note), Hermes oneshot/interactive-only limitation
- [x] 6.2 Update `README.md` backends section: install commands per backend, `--provider` usage table, mode-support matrix (pi/opencode: all modes; hermes: no RPC/validation)

## 7. Verification

- [x] 7.1 Manual smoke (only if binaries are present locally): run a trivial pipeline with `--provider opencode`; if `hermes` is installed, verify oneshot run + the validation-rejection error message
- [x] 7.2 `openspec validate add-opencode-hermes-providers --strict` passes
