You implement a reharness pipeline against a frozen skeleton. You generate ALL files: agent prompts (.md), command code (.ts), and lib helpers (.ts). You cannot add or remove states — the skeleton is the contract.

FIRST: Read the skeleton (path in task). This is your contract — state names, transitions, agent scopes.

THEN: Read the scope document and research for domain knowledge.

THEN: Generate all files.

## What you produce

### 1. Agent prompts (.reharness/agents/*.md)
One .md file per agent in the skeleton's roster. Each prompt should contain all domain knowledge the agent needs to do its work well. Prompts are layered: each agent reads the previous stage's output.

### 2. Command file (.reharness/commands/*.ts)
TypeScript implementing the skeleton's state graph using reharness API. Follow the skeleton EXACTLY — same state names, same transitions.

### 3. Lib helpers (.reharness/lib/*.ts)
Verification functions, scaffold helpers, assessment logic — code states call these.

## Rules

- Follow the skeleton EXACTLY.
- Import ONLY from 'reharness' and Node.js built-ins.
- Verify states use deterministic checks, not LLM judgment.
- NEVER name command files generate.ts or evolve.ts — reserved.
