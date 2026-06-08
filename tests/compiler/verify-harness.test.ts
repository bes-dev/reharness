import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { verifyHarness, snapshotBase } from "../../src/compiler/verify-harness.js";

/** Build a minimal compiled-pipeline layout with one agent leaf `a` and take a base snapshot. */
function setup(): { target: string; agentDir: string; sys: string } {
  const target = mkdtempSync(resolve(tmpdir(), "rh-vh-"));
  const root = resolve(target, "reharness");
  const agentDir = resolve(root, "agents", "cmd", "a"); // agents are namespaced per command: agents/<cmdId>/<name>/
  mkdirSync(resolve(agentDir, "skills"), { recursive: true });
  mkdirSync(resolve(root, "lib"), { recursive: true });
  mkdirSync(resolve(root, "skeletons"), { recursive: true });
  mkdirSync(resolve(root, "commands"), { recursive: true });
  const sys = resolve(agentDir, "SYSTEM.md");
  writeFileSync(sys, "base prompt");
  writeFileSync(resolve(root, "lib", "x-states.ts"), "export const x = 1;");
  snapshotBase(target, resolve(root, ".cache", "scratch", ".base-snapshot"));
  return { target, agentDir, sys };
}

test("no harness.json ⇒ leaf not listed, base unchanged ⇒ clean report", () => {
  const { target } = setup();
  try {
    const r = verifyHarness(target);
    assert.deepEqual(r.leaves, []);
    assert.deepEqual(r.baseChanged, []);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("valid harness with a resolvable skill ⇒ ok", () => {
  const { target, agentDir } = setup();
  try {
    writeFileSync(resolve(agentDir, "skills", "doc.md"), "knowledge");
    writeFileSync(resolve(agentDir, "harness.json"), JSON.stringify({ skills: ["skills/doc.md"] }));
    const r = verifyHarness(target);
    assert.equal(r.leaves.length, 1);
    assert.equal(r.leaves[0].ok, true);
    assert.equal(r.leaves[0].hasHarness, true);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("malformed harness.json ⇒ flagged, badFiles points at it", () => {
  const { target, agentDir } = setup();
  try {
    writeFileSync(resolve(agentDir, "harness.json"), "{ not json");
    const r = verifyHarness(target);
    assert.equal(r.leaves[0].ok, false);
    assert.match(r.leaves[0].reason, /invalid JSON/);
    assert.deepEqual(r.leaves[0].badFiles, [resolve(agentDir, "harness.json")]);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("dangling skill path ⇒ flagged", () => {
  const { target, agentDir } = setup();
  try {
    writeFileSync(resolve(agentDir, "harness.json"), JSON.stringify({ skills: ["skills/missing.md"] }));
    const r = verifyHarness(target);
    assert.equal(r.leaves[0].ok, false);
    assert.match(r.leaves[0].reason, /unresolved/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("a shared research-skill ref (../../../skills/x.md) that resolves is accepted", () => {
  const { target, agentDir } = setup();
  try {
    mkdirSync(resolve(target, "reharness", "skills"), { recursive: true });
    writeFileSync(resolve(target, "reharness", "skills", "github-api.md"), "domain knowledge");
    writeFileSync(resolve(agentDir, "harness.json"), JSON.stringify({ skills: ["../../../skills/github-api.md"] }));
    assert.equal(verifyHarness(target).leaves[0].ok, true);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("a model field is NOT a gate failure — model is a valid runtime field (enhance just won't author it)", () => {
  const { target, agentDir } = setup();
  try {
    writeFileSync(resolve(agentDir, "harness.json"), JSON.stringify({ model: "anthropic/claude-opus-4-8" }));
    assert.equal(verifyHarness(target).leaves[0].ok, true);
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("a modified base file is detected (the untouched-base guarantee)", () => {
  const { target, sys } = setup();
  try {
    writeFileSync(sys, "TAMPERED by enhance");
    const r = verifyHarness(target);
    assert.equal(r.baseChanged.length, 1);
    assert.match(r.baseChanged[0], /SYSTEM\.md$/);
  } finally { rmSync(target, { recursive: true, force: true }); }
});
