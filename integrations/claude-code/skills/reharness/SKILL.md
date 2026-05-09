---
name: reharness
description: Run reharness FSM commands or decide whether to use FSM orchestration for a task. Activates when the task involves multi-step workflows, code generation with verification, or structured automation. Can generate new FSMs, run existing FSMs, or evolve them.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# reharness — FSM Pipeline Orchestrator

Deterministic multi-agent pipelines with verification loops.

## When to Use

Use reharness instead of direct coding when:
- Task has clear sequential steps (spec → implement → verify)
- Output needs deterministic verification (tsc, tests, linting)
- Task will be repeated (generate multiple apps, review multiple PRs)
- Multiple agents with different expertise are needed

Do NOT use reharness when:
- Task is a quick one-off edit
- No clear verification criteria exist
- Task requires interactive back-and-forth

## Available Commands

Check what's available:
```bash
reharness --help
```

**Built-in:**
- `reharness generate [dir] <description>` — create an FSM
- `reharness evolve [--auto]` — improve FSM from logs

**Project-specific** (from `.reharness/commands/`):
```bash
reharness  # TUI shows all commands
```

## Decision Flow

1. Check if `.reharness/commands/` exists and has a relevant command → run it
2. If no suitable command exists → `reharness generate "description"` to create one
3. After running → check result, consider `reharness evolve` if quality was poor

## Model Selection

```bash
reharness <command> --model anthropic/claude-sonnet-4-6
```

Per-pipeline default or per-agent override available in pipeline code.

## Results

Pipeline outputs are files on disk. Check:
- Generated files in the project directory
- Logs in `logs/run-*/` or `.reharness/*/logs/`
- Verify reports: `verify-report.md`
