import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneRuns } from "../../src/runtime/persistence.js";

const mk = (dir: string, names: string[]) => names.forEach(n => mkdirSync(join(dir, n), { recursive: true }));

test("pruneRuns keeps the newest N run-* dirs (name-sorted == chronological), prunes older", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-runs-"));
  mk(dir, ["run-2026-06-01", "run-2026-06-02", "run-2026-06-03", "run-2026-06-04", "other"]);
  pruneRuns(dir, 2);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left.filter(d => d.startsWith("run-")), ["run-2026-06-03", "run-2026-06-04"]);
  assert.ok(left.includes("other"), "non-run dirs are never touched");
});

test("pruneRuns with keep<=0 is a no-op (retention disabled)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-runs-"));
  mk(dir, ["run-a", "run-b", "run-c"]);
  pruneRuns(dir, 0);
  assert.equal(readdirSync(dir).filter(d => d.startsWith("run-")).length, 3);
});

test("pruneRuns on a missing dir does not throw", () => {
  assert.doesNotThrow(() => pruneRuns(join(tmpdir(), "rh-nope-" + Math.random().toString(36).slice(2)), 5));
  assert.ok(!existsSync(join(tmpdir(), "definitely-not-created")));
});
