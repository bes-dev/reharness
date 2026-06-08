import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { buildGeneratePipeline } from "../../src/compiler/generate.js";

const SK = (id: string) =>
  `<skeleton id="${id}" initial="s" format-version="0.5"><description>${id}</description><usage>u</usage>` +
  `<state name="s" type="code"><contract><![CDATA[do work]]></contract><on event="DONE" target="done"/></state>` +
  `<state name="done" type="final" status="success"/><state name="error" type="final" status="error"/></skeleton>`;

/** Minimal mock context for invoking a meta-pipeline CODE-state entry directly (no LLM). */
const ctx = (config: any): any => ({ config, data: {}, emit: () => {}, retries: () => 0, retry: () => {} });

test("multi-command: construct archives each command's PRD; amend restores the SELECTED command's PRD", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-mc-"));
  try {
    const gen = resolve(dir, "reharness/.cache/scratch");
    mkdirSync(gen, { recursive: true });
    const p = buildGeneratePipeline({ cwd: dir, input: "x" });

    // compile "alpha": construct archives its PRD to prds/alpha.md
    writeFileSync(resolve(gen, "draft-skeleton.xml"), SK("alpha"));
    writeFileSync(resolve(gen, "prd.md"), "# PRD alpha\nbuild alpha");
    assert.equal(await (p.states as any).construct.entry(ctx({ name: "", amend: false, command: "" })), "DONE");
    assert.match(readFileSync(resolve(dir, "reharness/prds/alpha.md"), "utf8"), /PRD alpha/);

    // compile "beta": now prd.md (the working PRD) is beta's; alpha's lives only in the archive
    writeFileSync(resolve(gen, "draft-skeleton.xml"), SK("beta"));
    writeFileSync(resolve(gen, "prd.md"), "# PRD beta\nbuild beta");
    assert.equal(await (p.states as any).construct.entry(ctx({ name: "", amend: false, command: "" })), "DONE");
    assert.ok(existsSync(resolve(dir, "reharness/prds/beta.md")));

    // amend "alpha": load_amend must restore ALPHA's PRD as the working prd.md (not beta's) + seed its skeleton
    const ap = buildGeneratePipeline({ cwd: dir, input: "add X", amend: true, command: "alpha" });
    assert.equal(await (ap.states as any).load_amend.entry(ctx({ amend: true, command: "alpha" })), "DONE");
    assert.match(readFileSync(resolve(gen, "prd.md"), "utf8"), /PRD alpha/, "working PRD restored to the selected command");
    assert.match(readFileSync(resolve(gen, "draft-skeleton.xml"), "utf8"), /id="alpha"/, "draft seeded with alpha's skeleton");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multi-command: amend with no selector and several commands errors (asks to name one)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-mc-"));
  try {
    const gen = resolve(dir, "reharness/.cache/scratch");
    mkdirSync(gen, { recursive: true });
    const p = buildGeneratePipeline({ cwd: dir, input: "x" });
    for (const id of ["alpha", "beta"]) {
      writeFileSync(resolve(gen, "draft-skeleton.xml"), SK(id));
      writeFileSync(resolve(gen, "prd.md"), `# PRD ${id}`);
      await (p.states as any).construct.entry(ctx({ name: "", amend: false, command: "" }));
    }
    // amend without a selector + 2 commands ⇒ ERROR (can't guess which)
    const ap = buildGeneratePipeline({ cwd: dir, input: "add X", amend: true });
    assert.equal(await (ap.states as any).load_amend.entry(ctx({ amend: true, command: "" })), "ERROR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
