## Purpose

Defines which agent CLI backends the runtime can spawn for agent leaves, how a run is lowered to each backend's invocation, which run modes (oneshot, RPC, interactive) each backend supports, and how backend-level failures surface to the user.

## ADDED Requirements

### Requirement: Multiple registered agent backends
The runtime SHALL offer at least the backends `pi`, `opencode`, and `hermes`, and SHALL resolve the active backend from (in precedence order) the per-run `--provider` option, the pipeline definition's `provider` field, and the `REHARNESS_PROVIDER` environment variable, defaulting to `pi`.

#### Scenario: Selecting a backend per run
- **WHEN** a pipeline is run with `--provider opencode`
- **THEN** every agent leaf of that run is spawned through the OpenCode backend

#### Scenario: Default backend unchanged
- **WHEN** no `--provider`, `def.provider`, or `REHARNESS_PROVIDER` is set
- **THEN** agent leaves run on the `pi` backend exactly as before

#### Scenario: Unknown backend fails loud
- **WHEN** a run or pipeline definition names an unregistered provider
- **THEN** the run fails before any state executes with an error naming the unknown provider and listing every registered provider

### Requirement: Backend-neutral model and binary configuration
The runtime SHALL accept a backend-neutral model (`--model` / definition `model` / per-leaf `model`) and executable override for every backend, and SHALL continue to accept the legacy `piModel` / `piBinary` names as aliases for backward compatibility.

#### Scenario: Model passed to a non-Pi backend
- **WHEN** a run specifies `--model <id>` with `--provider hermes`
- **THEN** the Hermes invocation includes that model id in the backend's native model flag

#### Scenario: Legacy names still work
- **WHEN** an existing pipeline definition sets `piModel` and runs on `pi`
- **THEN** the Pi invocation uses that model, unchanged from prior behavior

### Requirement: OpenCode backend supports all run modes
The `opencode` backend SHALL support oneshot runs, interactive runs, and long-lived RPC sessions (used for in-session validation), with its stdout event stream normalized to the runtime's common event vocabulary (tool start/end, text, thinking, usage, turn end).

#### Scenario: Oneshot run produces normalized events
- **WHEN** an agent leaf without a validator runs on `opencode`
- **THEN** tool activity, assistant text, and token/cost usage from the OpenCode stream appear in the run log and the run's usage verdict

#### Scenario: In-session validation works on OpenCode
- **WHEN** an agent leaf with a validator runs on `opencode`
- **THEN** the runtime drives one live OpenCode session, re-prompting into the same session until validation passes or the attempt budget is exhausted

#### Scenario: Interactive session attaches to the terminal
- **WHEN** an interactive state runs on `opencode`
- **THEN** the OpenCode process runs with stdio inherited until the user exits, and a non-zero exit fails the leaf

### Requirement: Hermes backend supports oneshot and interactive modes only
The `hermes` backend (NousResearch hermes-agent) SHALL support oneshot and interactive runs, and SHALL fail loud with an actionable message when an RPC session is requested.

#### Scenario: Oneshot Hermes run
- **WHEN** an agent leaf without a validator runs on `hermes`
- **THEN** the hermes-agent CLI is spawned headlessly and its event stream is normalized into the common vocabulary

#### Scenario: Validation on Hermes fails loud
- **WHEN** an agent leaf with a validator is assigned to the `hermes` backend
- **THEN** the leaf fails before spawning with a message stating that `hermes` does not support RPC/validation mode and naming a supported backend

### Requirement: Missing backend binary produces an actionable error
When a backend's executable is not found, the runtime SHALL fail with a message naming the backend, the missing executable, and backend-specific install guidance.

#### Scenario: opencode not installed
- **WHEN** a run on `--provider opencode` spawns its first agent leaf and the `opencode` executable is not on `PATH`
- **THEN** the error names the `opencode` backend and its install command, not Pi's

### Requirement: Backend selection is orthogonal to pipeline semantics
Adding or selecting a backend SHALL NOT change FSM semantics: transitions, guards, retries, watchdog behavior, resume, and cost accounting operate identically on every backend.

#### Scenario: Watchdog and retry apply on all backends
- **WHEN** an agent leaf on any registered backend stalls (no stream events beyond the idle limit) or hits a transient backend failure
- **THEN** the same watchdog kill and transient-retry behavior applies as on `pi`

#### Scenario: Failures route through the existing error path
- **WHEN** an agent subprocess on any registered backend exits non-zero after retries
- **THEN** the leaf throws and the run routes to the error path exactly as with `pi`
