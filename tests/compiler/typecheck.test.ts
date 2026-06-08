import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { typecheckGenerated } from "../../src/compiler/typecheck.js";

/** A throwaway generated-project dir with one code-state lib file (ESM, like a real project). */
function project(libSource: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-tc-"));
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "t", private: true, type: "module" }));
  mkdirSync(resolve(dir, "reharness/lib"), { recursive: true });
  writeFileSync(resolve(dir, "reharness/lib/t-states.ts"), libSource);
  return dir;
}

test("typecheckGenerated: clean node code (fs + globals) → no errors", () => {
  const dir = project(`import { readFileSync } from 'fs';
export async function tEntry(c: any): Promise<'DONE'> {
  const s: string = readFileSync('x', 'utf-8'); c.data.n = s.length; return 'DONE';
}`);
  try { assert.deepEqual(typecheckGenerated(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("typecheckGenerated: a real type error is caught (resurrects the dead `npx tsc` gate)", () => {
  const dir = project(`export async function tEntry(c: any): Promise<'DONE'> {
  const n: string = 42; c.data.n = n; return 'DONE';
}`);
  try {
    const errs = typecheckGenerated(dir);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /TypeScript errors/);
    assert.match(errs[0], /not assignable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("typecheckGenerated: a missing BARE npm module is tolerated (manifest/provision concern), a missing RELATIVE one errors", () => {
  // bare: `import from 'pdfkit'` (not installed) → not a hard error; the manifest surfaces it, provision installs it
  const ok = project(`import PDF from 'pdfkit';\nexport async function tEntry(c: any): Promise<'DONE'> { const _ = PDF; return 'DONE'; }`);
  try { assert.deepEqual(typecheckGenerated(ok), []); } finally { rmSync(ok, { recursive: true, force: true }); }
  // relative: `import from '../../src/compiler/missing.js'` → a real bug in the generated code → hard error
  const bad = project(`import { x } from '../../src/compiler/missing.js';\nexport async function tEntry(c: any): Promise<'DONE'> { return ('' + x) as 'DONE'; }`);
  try { const e = typecheckGenerated(bad); assert.equal(e.length, 1); assert.match(e[0], /Cannot find module/); } finally { rmSync(bad, { recursive: true, force: true }); }
});

test("typecheckGenerated: no reharness TS files → no errors", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-tc-"));
  try { assert.deepEqual(typecheckGenerated(dir), []); } finally { rmSync(dir, { recursive: true, force: true }); }
});
