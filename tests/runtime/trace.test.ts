import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { collectTraces, findLeafTrace } from "../../src/runtime/trace.js";

/** A run dir whose trace tree mirrors work/: sequential `trace/plan/01-plan.md` + parallel
 *  `trace/leaf/<i>/NN-leaf.md`. */
function run(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-trace-"));
  const t = (rel: string, body: string) => {
    const p = resolve(dir, "trace", rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  t("plan/01-plan.md", "[thinking] planning\n[tool] bash ls\n");
  t("leaf/0/02-leaf.md", "[tool] parse_kv a=1\n");        // parallel branch 0
  t("leaf/1/03-leaf.md", "[tool] parse_kv b=2\n");        // parallel branch 1
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("collectTraces: concatenates every trace recursively (sequential + parallel instances)", () => {
  const { dir, cleanup } = run();
  try {
    const all = collectTraces(dir);
    assert.match(all, /planning/);
    assert.match(all, /parse_kv a=1/);
    assert.match(all, /parse_kv b=2/, "a parallel branch trace is collected (the old flat readdir missed these)");
  } finally { cleanup(); }
});

test("findLeafTrace: finds a leaf's trace under any instance dir; null when absent", () => {
  const { dir, cleanup } = run();
  try {
    assert.match(findLeafTrace(dir, "plan")!, /trace\/plan\/01-plan\.md$/);
    assert.match(findLeafTrace(dir, "leaf")!, /trace\/leaf\/[01]\/0[23]-leaf\.md$/, "a parallel leaf is found");
    assert.equal(findLeafTrace(dir, "nope"), null);
  } finally { cleanup(); }
});

test("collectTraces / findLeafTrace tolerate a missing trace dir", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-trace-"));
  try {
    assert.equal(collectTraces(dir), "");
    assert.equal(findLeafTrace(dir, "x"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
