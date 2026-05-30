import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSkeleton } from "./lint.js";
import type { Skeleton } from "../schema.js";

const base = (states: Skeleton["states"]): Skeleton => ({ id: "t", description: "", usage: "", initial: "a", states });

/** #8: codegen synthesizes ERROR → 'error' for code states; lint must require that target to exist. */
test("#8 flags a code state when no 'error' state exists", () => {
  const errs = lintSkeleton(base({
    a: { type: "code", on: { DONE: "done" } },
    done: { type: "final", status: "success" },
  }));
  assert.ok(errs.some(e => /no state named 'error'/.test(e)), errs.join("; "));
});

test("#8 satisfied when an 'error' state is present", () => {
  const errs = lintSkeleton(base({
    a: { type: "code", on: { DONE: "done" } },
    done: { type: "final", status: "success" },
    error: { type: "final", status: "error" },
  }));
  assert.ok(!errs.some(e => /no state named 'error'/.test(e)), errs.join("; "));
});

test("#8 satisfied when the code state declares its own ERROR transition", () => {
  const errs = lintSkeleton(base({
    a: { type: "code", on: { DONE: "done", ERROR: "done" } },
    done: { type: "final", status: "success" },
  }));
  assert.ok(!errs.some(e => /no state named 'error'/.test(e)), errs.join("; "));
});
