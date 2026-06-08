import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { loadLedger, recordBind, updateLedger, retentionTrim, type Ledger } from "../../src/compiler/evolve-ledger.js";

function setup() {
  const target = mkdtempSync(resolve(tmpdir(), "rh-ledger-"));
  const rh = resolve(target, "reharness");
  mkdirSync(resolve(rh, "agents", "cmd", "a"), { recursive: true });
  mkdirSync(resolve(rh, "tools", "cmd", "a"), { recursive: true });
  mkdirSync(resolve(rh, "run"), { recursive: true });
  return { target, rh, cleanup: () => rmSync(target, { recursive: true, force: true }) };
}

test("updateLedger counts a [tool] call in the trace and ++runsSinceBind", () => {
  const { rh, cleanup } = setup();
  try {
    const l: Ledger = { runsTotal: 0, tools: {} };
    recordBind(l, "../../../tools/cmd/a/t.mjs", "a", "parse_thing", "cmd");
    // trace lives under the run's trace/<stage>/ tree (mirrors work/) — updateLedger collects it recursively
    mkdirSync(resolve(rh, "run", "trace", "a"), { recursive: true });
    writeFileSync(resolve(rh, "run", "trace", "a", "01-a.md"), "[thinking] ...\n[tool] parse_thing {x:1}\n[tool] bash ls\n");
    updateLedger(l, resolve(rh, "run"));
    assert.equal(l.runsTotal, 1);
    assert.equal(l.tools["../../../tools/cmd/a/t.mjs"].calls, 1);
    assert.equal(l.tools["../../../tools/cmd/a/t.mjs"].runsSinceBind, 1);
  } finally { cleanup(); }
});

test("retentionTrim keeps a used tool, unbinds + archives an unused one past grace", () => {
  const { rh, cleanup } = setup();
  try {
    const USED = "../../../tools/cmd/a/used.routine.mjs", DEAD = "../../../tools/cmd/a/dead.routine.mjs";
    const l: Ledger = { runsTotal: 20, tools: {} };
    // a USED tool (calls high) and an UNUSED one (calls 0), both past grace
    recordBind(l, USED, "a", "used", "cmd"); recordBind(l, DEAD, "a", "dead", "cmd");
    l.tools[USED].calls = 10; l.tools[USED].runsSinceBind = 10;
    l.tools[DEAD].calls = 0; l.tools[DEAD].runsSinceBind = 10;
    writeFileSync(resolve(rh, "agents", "cmd", "a", "harness.json"), JSON.stringify({ extensions: [USED, DEAD] }));
    // the dead tool's full on-disk footprint: the neutral routine + both rendered backend wrappers + the self-test
    const deadFiles = ["dead.routine.mjs", "dead.pi.mjs", "dead.mcp.mjs", "dead.test.mjs"];
    for (const f of deadFiles) writeFileSync(resolve(rh, "tools", "cmd", "a", f), "x");
    const trimmed = retentionTrim(l, rh);
    assert.deepEqual(trimmed, [DEAD]);
    assert.ok(l.tools[USED], "used tool kept");
    assert.ok(!l.tools[DEAD], "dead tool dropped from ledger");
    const h = JSON.parse(readFileSync(resolve(rh, "agents", "cmd", "a", "harness.json"), "utf-8"));
    assert.deepEqual(h.extensions, [USED]);          // dead unbound from harness
    for (const f of deadFiles) { // ALL of the dead tool's files archived (recoverable) and removed from tools/
      assert.ok(existsSync(resolve(rh, ".cache", "evolve", ".archive", "cmd", "a", f)), `${f} archived`);
      assert.ok(!existsSync(resolve(rh, "tools", "cmd", "a", f)), `${f} removed from tools/`);
    }
  } finally { cleanup(); }
});

test("a tool within its grace period is never trimmed", () => {
  const { rh, cleanup } = setup();
  try {
    const l: Ledger = { runsTotal: 20, tools: {} };
    recordBind(l, "../../../tools/cmd/a/young.mjs", "a", "young", "cmd");
    l.tools["../../../tools/cmd/a/young.mjs"].runsSinceBind = 1; // grace default 3
    assert.deepEqual(retentionTrim(l, rh), []);
    assert.ok(l.tools["../../../tools/cmd/a/young.mjs"]);
  } finally { cleanup(); }
});

test("a fresh ledger loads as empty", () => {
  const { rh, cleanup } = setup();
  try { assert.deepEqual(loadLedger(rh), { runsTotal: 0, tools: {} }); } finally { cleanup(); }
});
