import { test } from "node:test";
import assert from "node:assert/strict";
import { entryFunctions, pruneEntryFns } from "../../src/compiler/lib-fns.js";

test("entryFunctions: lists exported *Entry fns; ignores helpers, non-exported, and string/comment mentions", () => {
  const src = `import { x } from 'y';
// mentions function ghostEntry in a comment — must be ignored
function helperEntry(c: any) { return 1; }            // not exported → not an entry
export function aEntry(c: any): Promise<'DONE'> { const s = "function bEntry"; return 'DONE' as any; }
export async function bEntry(c: any): Promise<'DONE'> { return 'DONE'; }`;
  assert.deepEqual(entryFunctions(src).map(f => f.name).sort(), ["a", "b"]);
});

test("pruneEntryFns: drops a dead entry, keeps a live one", () => {
  const src = `export function aEntry(c: any) { return 'A'; }
export function bEntry(c: any) { return 'B'; }`;
  const out = pruneEntryFns(src, new Set(["a"]))!;
  assert.ok(out.includes("aEntry"), "live kept");
  assert.ok(!out.includes("bEntry"), "dead dropped");
  assert.deepEqual(entryFunctions(out).map(f => f.name), ["a"]);
});

test("pruneEntryFns: a module-level helper AFTER a dead entry SURVIVES (the line-scan bug)", () => {
  // The old line-scan dropped everything from a dead entry up to the next `export function`, eating `fmt`.
  const src = `export function deadEntry(c: any) { return 'X'; }
function fmt(s: string) { return s.trim(); }
const SHARED = 42;
export function liveEntry(c: any) { return fmt(String(SHARED)); }`;
  const out = pruneEntryFns(src, new Set(["live"]))!;
  assert.ok(!out.includes("deadEntry"), "dead entry removed");
  assert.ok(out.includes("function fmt"), "helper after the dead entry preserved");
  assert.ok(out.includes("const SHARED = 42"), "module-level const preserved");
  assert.ok(out.includes("liveEntry"), "live entry preserved");
});

test("pruneEntryFns: a dead entry LAST in the file does not eat trailing code", () => {
  const src = `export function liveEntry(c: any) { return 'L'; }
export function deadEntry(c: any) { return 'D'; }
const TRAILING = 'keep me';`;
  const out = pruneEntryFns(src, new Set(["live"]))!;
  assert.ok(!out.includes("deadEntry"));
  assert.ok(out.includes("const TRAILING = 'keep me'"), "trailing const after a last dead entry preserved");
});

test("pruneEntryFns: returns null when nothing is dead", () => {
  const src = `export function aEntry(c: any) { return 'A'; }`;
  assert.equal(pruneEntryFns(src, new Set(["a"])), null);
});
