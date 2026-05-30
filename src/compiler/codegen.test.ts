import { test } from "node:test";
import assert from "node:assert/strict";
import { emitCommand } from "./codegen.js";
import type { Skeleton } from "./schema.js";

/** #1: when <inputs> is declared, the generated run() must parse flags/positionals into config — not just
 *  dump everything into config.input. (This is the regression that shipped broken twice.) */
test("#1 emitCommand generates an argument parser from <inputs>", () => {
  const sk: Skeleton = {
    id: "rev", description: "d", usage: "u", initial: "a",
    inputs: [
      { name: "repo", positional: true, required: true },
      { name: "models", type: "list", required: true },
      { name: "rounds", type: "number", default: "3" },
    ],
    states: { a: { type: "final", status: "success" } },
  };
  const out = emitCommand(sk, []);
  assert.match(out, /const flags/);                 // parser emitted
  assert.match(out, /positional\[0\]/);             // repo from positional slot
  assert.match(out, /config\["models"\]/);          // models from flag
  assert.match(out, /split\(','\)/);                // list coercion
  assert.match(out, /Number\(/);                    // number coercion
  assert.match(out, /return null/);                 // required → usage error
});

/** No <inputs> → legacy behavior preserved (only config.{target,input}). */
test("#1 emitCommand keeps legacy config when no <inputs>", () => {
  const sk: Skeleton = {
    id: "gen", description: "d", usage: "u", initial: "a",
    states: { a: { type: "final", status: "success" } },
  };
  const out = emitCommand(sk, []);
  assert.match(out, /const config = \{ target, input \}/);
  assert.doesNotMatch(out, /const flags/);
});

/** #10: an event with several retry-guarded branches must emit at most ONE c.retry per event. */
test("#10 retry increment is emitted once per event", () => {
  const sk: Skeleton = {
    id: "r", description: "d", usage: "u", initial: "n",
    states: {
      n: { type: "code", on: { FAIL: [
        { target: "n", guard: "retries:x<3" },
        { target: "n", guard: "retries:y<2" },
        { target: "error" },
      ] }, },
      error: { type: "final", status: "error" },
    },
  };
  const out = emitCommand(sk, ["n"]);
  const retryCalls = (out.match(/c\.retry\(/g) || []).length;
  assert.equal(retryCalls, 1, `expected exactly one c.retry(), got ${retryCalls}`);
});
