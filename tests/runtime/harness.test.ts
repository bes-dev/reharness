import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { loadHarness, resolvePrompt } from "../../src/runtime/fsm.js";

function setup(harness?: object) {
  const root = mkdtempSync(resolve(tmpdir(), "rh-harn-"));
  const agentsDir = resolve(root, "agents");
  mkdirSync(resolve(agentsDir, "a", "skills"), { recursive: true });
  if (harness) writeFileSync(resolve(agentsDir, "a", "harness.json"), JSON.stringify(harness));
  return { root, agentsDir };
}

test("no harness.json ⇒ {} (base pipeline, Pi defaults)", () => {
  const { root, agentsDir } = setup();
  try { assert.deepEqual(loadHarness(agentsDir, "a"), {}); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("reads model + resolves skills/extensions relative to the agent dir", () => {
  const { root, agentsDir } = setup({ model: "sonnet", skills: ["skills/doc.md"], extensions: ["x/web.ts"] });
  try {
    const h = loadHarness(agentsDir, "a");
    assert.equal(h.model, "sonnet");
    assert.deepEqual(h.skills, [resolve(agentsDir, "a", "skills/doc.md")]);
    assert.deepEqual(h.extensions, [resolve(agentsDir, "a", "x/web.ts")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a shared project skill (../../skills/x.md) resolves to the reharness/skills dir", () => {
  const { root, agentsDir } = setup({ skills: ["../../skills/github-api.md"] });
  try {
    // agentsDir/<a>/../../skills/x → root/skills/x (the shared, research-produced skills dir)
    assert.deepEqual(loadHarness(agentsDir, "a").skills, [resolve(root, "skills", "github-api.md")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("absolute skill/extension paths are kept as-is", () => {
  const { root, agentsDir } = setup({ skills: ["/abs/s.md"] });
  try { assert.deepEqual(loadHarness(agentsDir, "a").skills, ["/abs/s.md"]); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolvePrompt prefers <name>/SYSTEM.md, falls back to flat <name>.md", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rh-harn-"));
  const agentsDir = resolve(root, "agents");
  // flat layout (meta-pipeline / hand-written)
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(resolve(agentsDir, "flat.md"), "x");
  // dir layout (generated)
  mkdirSync(resolve(agentsDir, "dir"), { recursive: true });
  writeFileSync(resolve(agentsDir, "dir", "SYSTEM.md"), "y");
  try {
    assert.equal(resolvePrompt(agentsDir, "flat"), resolve(agentsDir, "flat.md"));
    assert.equal(resolvePrompt(agentsDir, "dir"), resolve(agentsDir, "dir", "SYSTEM.md"));
    assert.throws(() => resolvePrompt(agentsDir, "missing"), /Agent prompt not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed harness.json ⇒ {} (never breaks the run) but signals via onError", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rh-harn-"));
  const agentsDir = resolve(root, "agents");
  mkdirSync(resolve(agentsDir, "a"), { recursive: true });
  writeFileSync(resolve(agentsDir, "a", "harness.json"), "{ not json");
  try {
    const warnings: string[] = [];
    assert.deepEqual(loadHarness(agentsDir, "a", (m) => warnings.push(m)), {}); // degrades to {} — run not broken
    assert.equal(warnings.length, 1);                                            // ...but the loss is NOT silent
    assert.match(warnings[0], /harness\.json for "a" is invalid/);
    // absent harness.json must stay silent (no false warning)
    const none: string[] = [];
    loadHarness(agentsDir, "missing", (m) => none.push(m));
    assert.equal(none.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
