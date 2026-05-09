---
name: reharness-evolve
description: Investigate reharness FSM runs and improve the machine. Patches agent prompts, verify checks, code state logic, and skeleton topology. Use when FSMs need improvement or after failures.
allowed-tools: Bash, Read, Glob, Grep
---

# Evolve reharness FSM

Investigate run history and improve FSM quality.

## Usage

`/reharness-evolve [flags]`

## Flags

- `--interactive` — investigator agent runs in interactive mode for collaborative analysis

## Workflow

1. Run: `reharness evolve`
2. Investigator agent explores: run logs, filesystem, code, agent prompts
3. Traces root causes and writes patches
4. Patches applied with git versioning
5. Report:
   - Patches: `.reharness/evolve/patches.md`
   - Rollback: `git revert <sha>`

## When to Use

- After an FSM run that failed or underperformed
- After multiple runs with recurring errors
- To improve agent prompts based on observed behavior
