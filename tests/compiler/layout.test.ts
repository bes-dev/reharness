import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { parseSkeletonXML } from "../../src/compiler/xml.js";
import { generateFromSkeleton } from "../../src/compiler/codegen.js";

const SK = `<skeleton id="p" initial="a"><description>d</description><usage>u</usage>
 <state name="a" type="agent"><contract><![CDATA[do]]></contract><on event="DONE" target="done"/></state>
 <state name="b" type="agent"><contract><![CDATA[do]]></contract><on event="DONE" target="done"/></state>
 <state name="done" type="final" status="success"/></skeleton>`;

test("codegen writes each agent's prompt to agents/<cmdId>/<name>/SYSTEM.md (per-command namespace)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-layout-"));
  try {
    mkdirSync(resolve(dir, "reharness"), { recursive: true });
    generateFromSkeleton(parseSkeletonXML(SK), resolve(dir, "reharness"));
    const a = resolve(dir, "reharness/agents/p/a/SYSTEM.md"); // command id is "p"
    const b = resolve(dir, "reharness/agents/p/b/SYSTEM.md");
    assert.ok(existsSync(a), "agents/p/a/SYSTEM.md exists");
    assert.ok(existsSync(b), "agents/p/b/SYSTEM.md exists");
    assert.match(readFileSync(a, "utf8"), /TODO/);              // stub
    assert.ok(!existsSync(resolve(dir, "reharness/agents/a/SYSTEM.md")), "not the old flat layout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codegen is idempotent — does not clobber a filled SYSTEM.md", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-layout-"));
  try {
    mkdirSync(resolve(dir, "reharness"), { recursive: true });
    generateFromSkeleton(parseSkeletonXML(SK), resolve(dir, "reharness"));
    const a = resolve(dir, "reharness/agents/p/a/SYSTEM.md");
    writeFileSync(a, "FILLED PROMPT");
    generateFromSkeleton(parseSkeletonXML(SK), resolve(dir, "reharness")); // re-gen
    assert.equal(readFileSync(a, "utf8"), "FILLED PROMPT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
