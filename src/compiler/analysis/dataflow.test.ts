import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDataFlow } from "./dataflow.js";
import type { Skeleton } from "../schema.js";

/** #4: a code state that WRITES data.x and then has an outgoing guard reading data.x must NOT be flagged —
 *  guards are evaluated after the node's body, so the value is available. */
test("#4 no false use-before-def when a node's own guard reads what the node writes", () => {
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "n",
    states: {
      n: { type: "code", writes: ["data.x"], on: { DONE: [{ target: "done", guard: "expr:data.x" }, { target: "done" }] } },
      done: { type: "final", status: "success" },
    },
  };
  assert.deepEqual(analyzeDataFlow(sk), []);
});

/** Soundness preserved: a guard reading a key NOBODY writes is still flagged. */
test("#4 still flags a genuinely-undefined data read in a guard", () => {
  const sk: Skeleton = {
    id: "t", description: "", usage: "", initial: "n",
    states: {
      n: { type: "code", writes: [], on: { DONE: [{ target: "done", guard: "expr:data.y" }, { target: "done" }] } },
      done: { type: "final", status: "success" },
    },
  };
  const errs = analyzeDataFlow(sk);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /data\.y/);
});
