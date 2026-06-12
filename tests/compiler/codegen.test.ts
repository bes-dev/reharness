import { test } from "node:test";
import assert from "node:assert/strict";
import { emitCommand } from "../../src/compiler/codegen.js";
import { parseSkeletonXML, serializeSkeletonXML } from "../../src/compiler/xml.js";
import type { Skeleton } from "../../src/compiler/schema.js";

/** #1: when <inputs> is declared, the generated run() must parse flags/positionals into config — not just
 *  dump everything into config.input. (This is the regression that shipped broken twice.) */
test("#1 emitCommand generates an argument parser from <inputs>", () => {
  const sk: Skeleton = {
    id: "rev", description: "d", usage: "u", initial: "a",
    inputs: [
      { name: "repo", positional: true, required: true },
      { name: "models", type: "list", required: true },
      { name: "rounds", type: "number", default: "3" },
    ],
    states: { a: { type: "final", status: "success" } },
  };
  const out = emitCommand(sk, []);
  assert.match(out, /const flags/);                 // parser emitted
  assert.match(out, /positional\[0\]/);             // repo from positional slot
  assert.match(out, /config\["models"\]/);          // models from flag
  assert.match(out, /split\(','\)/);                // list coercion
  assert.match(out, /Number\(/);                    // number coercion
  assert.match(out, /return null/);                 // required → usage error
});

test("#1 emitCommand expands an env-rooted DEFAULT (~/$HOME) at the command boundary — external-target inputs", () => {
  const sk: Skeleton = {
    id: "dot", description: "d", usage: "u", initial: "a",
    inputs: [
      { name: "dotfiles_dir", default: "~/dotfiles" },   // external target with a home default
      { name: "style", default: "plain" },               // ordinary default — no expansion
    ],
    states: { a: { type: "final", status: "success" } },
  };
  const out = emitCommand(sk, []);
  assert.match(out, /const expandHome =/);                       // helper emitted (a ~ default exists)
  assert.match(out, /expandHome\("~\/dotfiles"\)/);             // the home default is wrapped
  assert.doesNotMatch(out, /expandHome\("plain"\)/);           // a plain default is NOT wrapped
  // and a skeleton with no env-rooted default emits no helper (no dead code)
  const plain = emitCommand({ ...sk, inputs: [{ name: "style", default: "plain" }] }, []);
  assert.doesNotMatch(plain, /expandHome/);
});

/** No <inputs> → legacy behavior preserved (only config.{target,input}). */
test("#1 emitCommand keeps legacy config when no <inputs>", () => {
  const sk: Skeleton = {
    id: "gen", description: "d", usage: "u", initial: "a",
    states: { a: { type: "final", status: "success" } },
  };
  const out = emitCommand(sk, []);
  assert.match(out, /const config = \{ target, input, __argv: args \}/);
  assert.doesNotMatch(out, /const flags/);
});

/** #10: an event with several retry-guarded branches must emit at most ONE c.retry per event. */
test("#10 retry increment is emitted once per event", () => {
  const sk: Skeleton = {
    id: "r", description: "d", usage: "u", initial: "n",
    states: {
      n: { type: "code", on: { FAIL: [
        { target: "n", guard: "retries:x<3" },
        { target: "n", guard: "retries:y<2" },
        { target: "error" },
      ] }, },
      error: { type: "final", status: "error" },
    },
  };
  const out = emitCommand(sk, ["n"]);
  const retryCalls = (out.match(/c\.retry\(/g) || []).length;
  assert.equal(retryCalls, 1, `expected exactly one c.retry(), got ${retryCalls}`);
});

import { emitCompiledFromSkeletonsDir } from "../../src/compiler/codegen.js";
import { reconcile } from "../../src/compiler/project-fs.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

test("emitCompiledFromSkeletonsDir: onlyId scopes _compiled.md to the target command (multi-command)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-cc-"));
  try {
    const rh = resolve(dir, "reharness");
    mkdirSync(resolve(rh, ".cache", "scratch"), { recursive: true });
    mkdirSync(resolve(rh, "skeletons"), { recursive: true });
    const sk = (id: string) =>
      `<skeleton id="${id}" initial="s" format-version="0.5"><description>d</description><usage>u</usage>` +
      `<state name="s" type="final" status="success" /></skeleton>`;
    writeFileSync(resolve(rh, "skeletons", "alpha.xml"), sk("alpha"));
    writeFileSync(resolve(rh, "skeletons", "beta.xml"), sk("beta"));
    emitCompiledFromSkeletonsDir(rh, "beta");
    const compiled = readFileSync(resolve(rh, ".cache", "scratch", "_compiled.md"), "utf-8");
    assert.match(compiled, /# Compiled Pipeline: beta/);
    assert.doesNotMatch(compiled, /# Compiled Pipeline: alpha/); // the sibling command is NOT in the view
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Regression (2025-01-14 review §2.1, the data-loss blocker): reconcile must key orphan-deletion off the skeleton
 *  FILES on disk, NOT off codegen/parse success — otherwise a transient generation failure (or a present-but-broken
 *  skeleton) silently wipes a command's hand-filled prompts. Only a DELETED skeleton is a true orphan. */
test("reconcile deletes only true orphans; a present (even unparseable) skeleton keeps its artifacts", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-rec-"));
  try {
    const rh = resolve(dir, "reharness");
    const skDir = resolve(rh, "skeletons"); mkdirSync(skDir, { recursive: true });
    const agents = resolve(rh, "agents");
    // alpha: a valid skeleton whose only agent leaf is 's'
    writeFileSync(resolve(skDir, "alpha.xml"),
      `<skeleton id="alpha" initial="s" format-version="0.5"><description>d</description><usage>u</usage>` +
      `<state name="s" type="agent"><contract><![CDATA[c]]></contract><on event="DONE" target="f"/></state>` +
      `<state name="f" type="final" status="success"/></skeleton>`);
    mkdirSync(resolve(agents, "alpha", "s"), { recursive: true });
    mkdirSync(resolve(agents, "alpha", "stale"), { recursive: true }); // a leaf no longer in alpha's skeleton
    // bad: skeleton FILE present but unparseable (the transient-corruption case)
    writeFileSync(resolve(skDir, "bad.xml"), "<skeleton not xml");
    mkdirSync(resolve(agents, "bad", "leaf"), { recursive: true });
    // orphan: NO skeleton file at all (a genuinely deleted command)
    mkdirSync(resolve(agents, "orphan", "leaf"), { recursive: true });

    reconcile(rh);

    assert.ok(existsSync(resolve(agents, "alpha", "s")), "live command's current leaf is kept");
    assert.ok(!existsSync(resolve(agents, "alpha", "stale")), "within a parsed command, a leaf absent from the skeleton is pruned");
    assert.ok(existsSync(resolve(agents, "bad", "leaf")), "present-but-unparseable skeleton keeps its artifacts (NOT wiped)");
    assert.ok(!existsSync(resolve(agents, "orphan")), "a command with no skeleton file is a true orphan → removed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Regression (audit): a wait state's `timeout` attribute must map ONLY to waitTimeout, not also the universal
 *  `timeout` — otherwise it serializes a DUPLICATE XML attr and codegen emits a DUPLICATE `timeoutMs` (TS1117). */
test("a wait state's timeout is not double-parsed (one XML attr, one timeoutMs)", () => {
  const xml = `<skeleton id="w" initial="wait1" format-version="0.5"><description>d</description><usage>u</usage>` +
    `<state name="wait1" type="wait" mode="file" path="/tmp/x" timeout="10m"><on event="DONE" target="f"/><on event="TIMEOUT" target="f"/></state>` +
    `<state name="f" type="final" status="success"/></skeleton>`;
  const sk = parseSkeletonXML(xml);
  assert.equal(sk.states.wait1.timeout, undefined);                              // wait owns @_timeout (→ waitTimeout)
  assert.equal((serializeSkeletonXML(sk).match(/timeout=/g) || []).length, 1);   // no duplicate attr (valid XML)
  assert.equal((emitCommand(sk, []).match(/timeoutMs:/g) || []).length, 1);      // no duplicate key (compiles)
});

test("a <go> with both guard and retries-key survives parse→serialize→codegen (no silent drop)", () => {
  const xml = `<skeleton id="t" initial="a"><state name="a" type="switch">` +
    `<go guard="data.has_blocking == &quot;yes&quot;" retries-key="cf" retries-max="2" target="a"/>` +
    `<go target="b"/></state><state name="b" type="final" status="success"/></skeleton>`;
  const sk = parseSkeletonXML(xml);
  const ser = serializeSkeletonXML(sk);
  assert.ok(ser.includes("guard=") && ser.includes('retries-key="cf"') && ser.includes('retries-max="2"'),
    "serialize must keep the condition AND the bound together");
  const code = emitCommand(sk, []);
  assert.match(code, /\(c\.data\.has_blocking == "yes"\) && c\.retries\('cf'\) < 2/);
});
