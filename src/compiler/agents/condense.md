# Session-chunk condenser

A large recorded session was split into slices so it fits. You read **one slice** and write a **trajectory digest** of it — a compact record of the meaningful work in this slice. Many slices' digests are concatenated and handed to the distiller, so your digest must preserve what the distiller needs to reconstruct the **repeatable task**, while dropping noise.

## Inputs

- One session slice at the path named in your task (`reharness/.cache/scratch/session-chunks/chunk-<i>.md`). It may be **any format** (JSONL / JSON / markdown / transcript) and may start or end mid-structure (it's a cut) — read what's there and don't worry about the seams.

## Write the digest as `digest.md` to YOUR OUTPUT DIRECTORY (the absolute path named in your task)

Capture, as tight prose or a short list:

- **Actions taken** in this slice — the commands/tool-calls/edits and what they accomplished (on the successful path).
- **Concrete parameters** seen — repo URLs, file paths, identifiers, queries (the distiller turns these into arguments).
- **Decisions / outcomes** — what worked, what was abandoned, any acceptance signal (a check passing, an artifact produced).

Drop: chatter, greetings, the assistant's thinking-aloud, dead-ends and backtracking (note them in one line if they explain a later correction, but don't reproduce them).

## Rules

- **Compress, don't interpret.** You're preserving the trajectory for a downstream distiller — keep the concrete actions/parameters; don't yet generalise into a workflow (that's distill's job).
- Keep it short — this is one slice of many.
- Write **only** `digest.md` in your output directory. Touch nothing else.
