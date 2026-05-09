---
name: reharness-generate
description: Generate a reharness FSM from a natural language description. Creates FSM-orchestrated multi-agent workflows with deterministic verification. Use when asked to create an FSM, build an FSM workflow, or automate a multi-step process.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# Generate reharness Pipeline

Create a deterministic multi-agent pipeline from a description.

## Usage

`/reharness-generate <description>`

## Modes

**Standalone** (new directory): when description starts with a path
```bash
reharness generate ./my-pipeline "Pipeline for generating API documentation"
```

**In-project** (add command to current project): when description is just text
```bash
reharness generate "Code review FSM for this project"
```

In-project mode explores the codebase first, then generates a command tailored to the project.

## Workflow

1. Run: `reharness generate $ARGUMENTS`
2. Wait for completion (may take several minutes — research + design + code generation)
3. Report what was generated:
   - Command files in `.reharness/commands/`
   - Agent prompts in `.reharness/agents/`
   - Lib helpers in `.reharness/lib/`
4. Show how to use: `reharness <command-name>`

## Model Selection

Add `--model <id>` to use a specific model:
```bash
reharness generate "..." --model anthropic/claude-sonnet-4-6
```

## After Generation

New commands are immediately available in the reharness TUI — no restart needed.
