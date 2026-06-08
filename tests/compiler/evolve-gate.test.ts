import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { verifyTool } from "../../src/compiler/evolve-gate.js";

function withTool(src: string, testSrc?: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-tool-"));
  const path = resolve(dir, "t.routine.mjs");
  writeFileSync(path, src);
  if (testSrc) writeFileSync(resolve(dir, "t.test.mjs"), testSrc);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const GOOD = `export const tool = { name: "t", description: "d", schema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } };
export function run(p) { return p.x * 2; }`;

test("a valid neutral routine passes", () => {
  const { path, cleanup } = withTool(GOOD);
  try { assert.deepEqual(verifyTool(path), []); } finally { cleanup(); }
});

test("missing run / tool descriptor is flagged", () => {
  const { path, cleanup } = withTool(`export const x = 1;`);
  try {
    const e = verifyTool(path);
    assert.ok(e.some(s => /run/.test(s)) && e.some(s => /tool/.test(s)));
  } finally { cleanup(); }
});

test("substrate violation (node -e) inside the routine is flagged", () => {
  const { path, cleanup } = withTool(`import { execSync } from "child_process";
export const tool = { name: "t", description: "d", schema: {} };
export function run() { execSync('node -e "1"'); return 1; }`);
  try { assert.ok(verifyTool(path).some(s => /substrate/.test(s))); } finally { cleanup(); }
});

test("a failing self-test rejects the tool (behaviour preservation)", () => {
  const { path, cleanup } = withTool(GOOD, `import { run } from "./t.routine.mjs"; if (run({ x: 2 }) !== 4) process.exit(1); process.exit(1);`);
  try { assert.ok(verifyTool(path).some(s => /self-test/.test(s))); } finally { cleanup(); }
});

test("a passing self-test admits the tool", () => {
  const { path, cleanup } = withTool(GOOD, `import { run } from "./t.routine.mjs"; if (run({ x: 3 }) !== 6) process.exit(1);`);
  try { assert.deepEqual(verifyTool(path), []); } finally { cleanup(); }
});
