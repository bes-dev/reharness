# reharness Tool

You have access to `reharness` — a deterministic multi-agent FSM framework. Use it for structured multi-step tasks instead of doing everything in one shot.

## When to Use

Use `reharness` when:
- The task has clear sequential phases (research → design → implement → verify)
- The output needs deterministic verification (compilation, tests, linting)
- The task will be repeated (generating multiple apps, reviewing multiple codebases)
- You need to coordinate multiple focused agents

Don't use it for quick edits, single-file changes, or tasks without clear verification criteria.

## Commands

### Check available commands
```bash
reharness --help
```

### Generate a new pipeline
```bash
# Standalone (new directory)
reharness generate ./my-pipeline "Pipeline for generating API documentation from OpenAPI specs"

# In-project (adds command to current .reharness/)
reharness generate "Code review FSM for this project"
```

### Run a FSM command
```bash
reharness build myapp "todo app with categories"
reharness review "check the latest changes"
```

### Improve pipeline from run history
```bash
reharness evolve
```

### Use specific model
```bash
reharness generate "..." --model anthropic/claude-sonnet-4-6
```

## How It Works

reharness runs a finite state machine where each state either:
- Calls an LLM agent with a focused prompt (one task, one agent)
- Runs deterministic code (shell commands, file checks)

States produce files on disk. Next state reads those files. Verify states use shell commands (tsc, pytest, eslint) — not LLM judgment. If verify fails, fix agent reads exact error report and patches.

## Project Structure

After `reharness generate` or `reharness init`, the project has:
```
.reharness/
├── commands/    # Pipeline definitions (auto-discovered)
├── agents/      # Agent prompts (.md files)
└── lib/         # Shared verification helpers
```

## Key Principle

Each agent sees only its prompt + files on disk. Agents don't share context. Communication is through filesystem artifacts. This means agents can be small, focused, and run with cheaper models while maintaining quality through deterministic verification.
