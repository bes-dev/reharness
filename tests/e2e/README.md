# e2e — `evolve` end-to-end smoke

Reproducible, asserting demos of `evolve`'s LLM-backed capabilities. **Not part of `npm test`** — these spawn `pi`
(a real model) and take ~1–2 min each. They are the formalized version of the throwaway `examples/evolvedemo` +
`examples/tooldemo` testbeds.

## Run

```
npm run e2e             # all cases (builds first)
npm run e2e -- heal     # one case: heal | toolgen
```

Requires `pi` on PATH and a usable default model (set `PI_MODEL` / your pi config as usual). Work dirs are written
under `tests/e2e/.work/` (git-ignored) and rebuilt fresh each run.

## Cases

| case | what it proves | asserts |
|---|---|---|
| `heal` | **self-heal (Track 2):** a `wordcount` pipeline with a deliberate leaf bug (inverted existence check) fails; `evolve` diagnoses + repairs the leaf, re-verifies, and re-runs to confirm. | the buggy run fails; after `evolve`, the same command **succeeds** |
| `toolgen` | **tool-gen (Track 1):** a `kvstats` agent leaf whose trace re-derives a `key=value` parse routine; `evolve` extracts it into a Pi `registerTool` extension, gates it, and binds it to the leaf. | a tool `.mjs` is bound in the leaf's `harness.json` `extensions` |

Each case builds its pipeline from scratch via the real codegen (`generateAllFromSkeletons`) + a hand-filled lib,
so it exercises the full machinery, not a snapshot. The `toolgen` trace is a stand-in for a real agent run (in
production it comes from running the pipeline). Credential-free — both pipelines are pure-local.
