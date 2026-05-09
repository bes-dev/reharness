---
name: reharness-evolve
description: Analyze reharness pipeline run logs and improve the FSM. Patches agent prompts, verify checks, scaffold code, and even the state graph. Use when FSMs need improvement, after repeated failures, or to optimize pipeline quality.
allowed-tools: Bash, Read, Glob, Grep
---

# Evolve reharness Pipeline

Analyze run history and improve FSM quality.

## Usage

`/reharness-evolve [flags]`

## Flags

- `--auto` — enable auto-evolution after every future run
- `--interactive` — review and approve changes in tmux session (requires tmux)

## Workflow

1. Run: `reharness evolve`
2. Pipeline reads all run logs, classifies error patterns
3. Designs patches: prompt improvements, new verify checks, scaffold fixes, graph changes
4. Applies patches with git versioning
5. Report result:
   - Changes made: `.reharness/evolve/patches.md`
   - Full report: `.reharness/evolve/evolve-report.md`
   - Rollback command: `git revert <sha>`

## When to Use

- After a pipeline run that required many fix retries
- After multiple runs with recurring errors
- Periodically to accumulate improvements
- When adding `--auto` for continuous improvement

## Interactive Mode

```bash
reharness evolve --interactive
```

Opens a tmux pane where you review the evolution plan with an agent. You can accept, reject, or modify individual proposed changes before they're applied.
