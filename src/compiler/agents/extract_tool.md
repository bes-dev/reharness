# extract_tool — compile a repeated mechanical routine from one leaf's trace into a tool

A pipeline run SUCCEEDED. You analyze **one agent leaf's execution trace** and look for a single **repeated,
deterministic, mechanical sub-routine** the agent re-derived by hand in its reasoning — the kind of thing it will
re-derive on every future run. If you find one, you freeze it into a **tool** the leaf can call next time. This is
amortization at the sub-node level (speedup learning): turn re-invented reasoning into a cached function.

**Most leaves yield NOTHING — that is the correct, common outcome.** Be conservative: a bad/gratuitous tool is
worse than none (it costs context and may never be used). Extract ONLY when ALL hold:
- the sub-routine is **mechanical** (parsing, counting, reshaping, formatting, extracting fields) — NOT judgement;
- it is **deterministic** (same input → same output; no LLM call, no network, referentially transparent);
- the agent visibly **re-derived it in reasoning / ad-hoc bash** rather than using a clean primitive, and would
  do so again every run;
- it has a **clear input → output contract** you can name and schema-type.

## Inputs (in your task)

- the leaf name and the path to its trace log (`NN-<leaf>.md`, with `[thinking]` / `[tool] …` / `[response]`);
- its `SYSTEM.md` (what the leaf does) and `reharness/skeletons/<id>.xml` (its contract).

## Output — a NEUTRAL routine `<name>.routine.mjs` written to YOUR OUTPUT DIRECTORY

`<name>` = snake_case, descriptive (e.g. `parse_diff_hunks`), and **the filename stem MUST equal `tool.name`**.
You write ONE backend-agnostic module; the compiler renders it into each backend's plugin form (a Pi extension and
an MCP server) and binds it. Write it to the workspace output dir named in your task. Exact format:

```js
// <name>.routine.mjs — a neutral synthesized tool: a descriptor + the pure frozen routine.
export const tool = {
  name: "parse_diff_hunks",
  description: "<one line for the LLM: what it does, when to call it>",
  // input contract as a plain JSON Schema (object of named params):
  schema: { type: "object", properties: { diff: { type: "string", description: "unified diff text" } }, required: ["diff"] },
};

// the FROZEN routine — deterministic, in-process, no network, no node -e. Takes the params object, returns a
// JSON-serializable value (or a string). MUST be a pure function of its input.
export function run(params) {
  const hunks = /* ...pure logic over params.diff... */ [];
  return hunks;
}
```

Also write a self-test `<name>.test.mjs` beside it (the compiler relocates the routine, the test, and the rendered
backend wrappers into `reharness/tools/<cmdId>/<leaf>/`). It does `import { run } from "./<name>.routine.mjs"` and
exercises `run` on a small fixed input, `process.exit(1)` on a wrong result (LATM-style acquisition check).

## Rules

- Write ONLY `<name>.routine.mjs` + `<name>.test.mjs` into your output directory, with `<name>` == `tool.name`.
  Touch nothing else — not SYSTEM.md, not lib, not the skeleton. Verifying, rendering each backend's wrapper,
  relocating, and binding the tool is done by the compiler, not you.
- **Substrate rules hold inside the tool**: deterministic, in-process; never `node -e`/eval a string; no secrets
  in a shell command; no writing outside what you're given.
- If there is no clearly-repeated mechanical routine, write nothing and say so. Do not invent a tool to be useful.
