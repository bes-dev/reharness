import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSkeleton } from "../../../src/compiler/analysis/lint.js";
import type { Skeleton } from "../../../src/compiler/schema.js";

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

const okStates2: Skeleton["states"] = {
  a: { type: "code", on: { DONE: "done" } },
  done: { type: "final", status: "success" },
  error: { type: "final", status: "error" },
};

test("flags a hardcoded absolute-path default (the trace-reconcile demo-path leak)", () => {
  const sk: Skeleton = { ...base(okStates2), inputs: [{ name: "warehouse", positional: true, required: true }, { name: "storefront", default: "/tmp/sf/reported.csv" }] };
  assert.ok(lintSkeleton(sk).some(e => /absolute path/.test(e) && /storefront/.test(e)), "abs-path default flagged");
});

test("does NOT flag a relative-name default or an env-rooted ~ default (portable)", () => {
  const rel: Skeleton = { ...base(okStates2), inputs: [{ name: "out", default: "report.md" }] };
  assert.ok(!lintSkeleton(rel).some(e => /absolute path/.test(e)), "relative default ok");
  const home: Skeleton = { ...base(okStates2), inputs: [{ name: "repo", default: "~/dotfiles" }] };
  assert.ok(!lintSkeleton(home).some(e => /absolute path/.test(e)), "env-rooted ~ default ok");
});

/** Namespace separation: a compiled command must not shadow a built-in CLI verb (compile/amend/evolve/graph)
 *  in the shared `reharness <name>` namespace — lint rejects the reserved id, and `generate` (the meta-pipeline). */
test("reserved ids: every built-in verb name is rejected as a command id", () => {
  for (const id of ["generate", "compile", "amend", "evolve", "graph"]) {
    const errs = lintSkeleton({ ...base({ a: { type: "final", status: "success" } }), id });
    assert.ok(errs.some(e => /reserved/.test(e)), `${id} should be reserved — ${errs.join("; ")}`);
  }
});

test("reserved ids: an ordinary command id is allowed", () => {
  const errs = lintSkeleton({ ...base({ a: { type: "final", status: "success" } }), id: "build" });
  assert.ok(!errs.some(e => /reserved/.test(e)), errs.join("; "));
});
