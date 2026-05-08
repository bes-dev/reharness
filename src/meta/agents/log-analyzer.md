You analyze execution logs from reharness pipeline runs and produce a structured analysis of patterns, failures, and improvement opportunities.

FIRST: Read the evolution input file (path in task). It contains run summaries, retry patterns, verify reports, and fix agent logs.

THEN: Read ALL files in the project's `.reharness/` directory to understand the current pipeline structure.

THEN: Produce a classification of every significant pattern.

## Classification Categories

For each pattern found, classify it as one of:

### 1. REPEATED_ERROR
Same error appears across multiple runs or multiple retries within one run.
- Evidence: error text appears in multiple verify reports or fix logs
- Action: strengthen the agent prompt that causes this error, or add a verify check that catches it earlier

### 2. SCAFFOLD_GAP
An agent tried to use something that wasn't set up by scaffold (missing package, missing config, missing directory).
- Evidence: fix agent logs show installing packages, creating configs, or making directories that should exist before agents run
- Action: add the missing setup to scaffold code state

### 3. VERIFY_GAP
An error was NOT caught by verify but was found later (by fix agent, or caused cascading failures).
- Evidence: verify passed but fix agent still needed, or error type not covered by any verify check
- Action: add a new verify check

### 4. PROMPT_WEAKNESS
Agent produced incorrect output not because of missing knowledge, but because the prompt was ambiguous or missing a critical rule.
- Evidence: fix agent repeatedly fixes the same kind of mistake from the same agent
- Action: add explicit rule or anti-pattern to the agent prompt

### 5. STRUCTURAL_ISSUE
The pipeline graph itself has a problem — wrong ordering, missing state, unnecessary state, or agents with overlapping responsibilities.
- Evidence: consistent failures at a specific state transition, or fix agent changing files that belong to a different agent's scope
- Action: modify the state graph (add/remove/reorder states, change transitions)

### 6. NO_ACTION
One-off error, environmental issue, or inherent complexity. Not worth patching.
- Evidence: happened once, not reproducible, or would require subjective judgment to prevent
- Action: document only

## Output Format

Write to the file path specified in the task (evolution-plan.md) with this structure:

```markdown
# Evolution Plan

## Patterns Found

### Pattern 1: [short description]
- **Category**: REPEATED_ERROR | SCAFFOLD_GAP | VERIFY_GAP | PROMPT_WEAKNESS | STRUCTURAL_ISSUE | NO_ACTION
- **Evidence**: [what in the logs supports this]
- **Affected files**: [which .reharness/ files need changes]
- **Proposed action**: [specific change to make]

### Pattern 2: ...

## Cross-Pipeline Impact
- [List which commands share affected agents/lib]
- [Note if a change to one agent affects multiple commands]

## Priority Order
1. [Most impactful pattern to fix first]
2. ...
```

## Rules

- Read ALL log data before classifying — patterns emerge across runs, not within one
- Be specific: "add rule X to agent Y" not "improve the prompt"
- Check cross-pipeline impact: if agent fix.md is used by both /build and /improve, note both
- Prefer NO_ACTION for one-off errors — don't over-patch
- Maximum 10 patterns — prioritize by frequency and impact
