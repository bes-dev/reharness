import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { recoverSkills } from "../../src/compiler/generate.js";

test("recoverSkills recovers from BOTH the out-dir top level AND the nested reharness/skills/ path", () => {
  // An agent may write a skill to the top of its out dir, OR follow the prompt's literal `reharness/skills/<t>.md`
  // path (nested inside out). Both must be recovered or a skill is stranded where enhance can't attach it.
  const target = mkdtempSync(resolve(tmpdir(), "rs-target-"));
  const out = mkdtempSync(resolve(tmpdir(), "rs-out-"));
  writeFileSync(resolve(out, "top.md"), "top-level skill");
  mkdirSync(resolve(out, "reharness/skills"), { recursive: true });
  writeFileSync(resolve(out, "reharness/skills/nested.md"), "nested skill");
  recoverSkills(target, { out: () => out } as any);
  const got = existsSync(resolve(target, "reharness/skills")) ? readdirSync(resolve(target, "reharness/skills")).sort() : [];
  assert.deepEqual(got, ["nested.md", "top.md"]);
});
