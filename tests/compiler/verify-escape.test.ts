import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceEscapes, substrateViolations, unprovisionableImports, emptyOutputDefaults, runtimeInstalls, unawaitedShell, stripComments } from "../../src/compiler/verify.js";
import type { InputDecl } from "../../src/compiler/schema.js";

test("flags os.tmpdir / mkdtemp(os.tmpdir()) — the real reviewer_v1 escape", () => {
  assert.deepEqual(workspaceEscapes(`const d = mkdtempSync(join(os.tmpdir(), 'clone-'));`), ["os.tmpdir()"]);
});

test("flags os.homedir, process.env.TMPDIR, and absolute/home path literals", () => {
  assert.deepEqual(workspaceEscapes(`writeFileSync(join(os.homedir(), 'x'), d)`), ["os.homedir()"]);
  assert.deepEqual(workspaceEscapes(`const t = process.env.TMPDIR;`), ["process.env.TMPDIR/HOME"]);
  assert.deepEqual(workspaceEscapes(`mkdirSync('/tmp/work')`), ["absolute system path literal"]);
  assert.deepEqual(workspaceEscapes("writeFileSync(`/var/data/x`, d)"), ["absolute system path literal"]);
  assert.deepEqual(workspaceEscapes(`readFileSync('~/notes.md')`), ["home (~/) path literal"]);
});

test("clean workspace code (c.out / c.dir only) is NOT flagged", () => {
  const src = `writeFileSync(join(c.out(), 'out.json'), d); readFileSync(join(c.dir('ingest'), 'in.txt'));`;
  assert.deepEqual(workspaceEscapes(src), []);
});

test("precision: github API URL path fragments are NOT flagged", () => {
  assert.deepEqual(workspaceEscapes("curlGithub('GET', `/repos/${owner}/${repo}/issues`)"), []);
  assert.deepEqual(workspaceEscapes(`headers.push('Content-Type: application/json')`), []);
});

test("substrate: flags the node-EVAL form, string and array (the reviewer_v2 disaster)", () => {
  assert.ok(substrateViolations("execSync(`node -e ${JSON.stringify(script)}`)").length > 0);
  assert.ok(substrateViolations(`spawnSync('node', ['-e', script])`).length > 0);
  assert.ok(substrateViolations(`execSync('node --eval ' + s)`).length > 0);
  assert.ok(substrateViolations(`spawnSync('node', ['--eval', s])`).length > 0);
});

test("substrate: legit subprocesses NOT flagged — fetch, git, and running a node SCRIPT FILE", () => {
  assert.deepEqual(substrateViolations(`const r = await fetch(url, { headers });`), []);
  assert.deepEqual(substrateViolations(`spawnSync('git', ['clone', '--depth', '1', url, dest])`), []);
  // running a node script file (external/target script, or code-exec via a written file) is legitimate
  assert.deepEqual(substrateViolations(`spawnSync('node', [join(c.dir('clone'), 'scripts/build.js')])`), []);
  assert.deepEqual(substrateViolations(`spawnSync('node', [scriptPath, '--flag'])`), []);
});

test("substrateViolations: flags CJS-isms in an ESM lib (require/__dirname), allows createRequire", () => {
  assert.ok(substrateViolations(`const x = require('pdfkit');`).some(s => /require/.test(s)), "bare require flagged");
  assert.ok(substrateViolations(`const p = __dirname + '/x';`).some(s => /__dirname/.test(s)), "__dirname flagged");
  // the legitimate ESM escape hatch must NOT be flagged
  assert.equal(substrateViolations(`import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst x = require('pdfkit');`).length, 0);
})

test("unprovisionableImports: flags a dep loaded via a VARIABLE specifier (the trace-mdhtml defeat)", () => {
  assert.ok(unprovisionableImports(`const lib = c.data.library || 'marked'; const m = await import(lib);`).length > 0);
  assert.ok(unprovisionableImports(`const m = await import(c.config.parser);`).length > 0);
  assert.ok(unprovisionableImports(`import(libraryName).then(m => m.parse(s))`).length > 0);
});

test("unprovisionableImports: a LITERAL specifier (static or dynamic) is NOT flagged — the manifest can see it", () => {
  assert.deepEqual(unprovisionableImports(`import marked from 'marked';`), []);
  assert.deepEqual(unprovisionableImports(`const { marked } = await import('marked');`), []);
  assert.deepEqual(unprovisionableImports(`const m = await import(\n  'marked'\n);`), []);
  assert.deepEqual(unprovisionableImports(`const u = import.meta.url; readFileSync('x');`), []);
});

test("emptyOutputDefaults: flags default=\"\" on a config value used as a write/path target (proofread bug)", () => {
  const out: InputDecl[] = [{ name: "draft", positional: true, required: true }, { name: "output", default: "" }];
  assert.deepEqual(emptyOutputDefaults(out, `writeFileSync(join(c.config.target, c.config.output), text);`), ["output"]);
  assert.deepEqual(emptyOutputDefaults(out, `await writeFile(c.config.output, text);`), ["output"]);
});

test("emptyOutputDefaults: does NOT flag an empty default on optional TEXT (an optional-input false positive)", () => {
  const ins: InputDecl[] = [{ name: "diff", positional: true, required: true }, { name: "context", default: "" }];
  // context is concatenated into a prompt string, never used as a path → legitimate empty default
  assert.deepEqual(emptyOutputDefaults(ins, `const task = base + (c.config.context ? '\\n' + c.config.context : '');`), []);
});

test("emptyOutputDefaults: concrete default and non-string args are not flagged", () => {
  assert.deepEqual(emptyOutputDefaults([{ name: "output", default: "report.md" }], `writeFileSync(join(d, c.config.output), x)`), []);
  assert.deepEqual(emptyOutputDefaults([{ name: "models", type: "list", default: "" }], `for (const m of c.config.models) writeFileSync(join(d, m), x)`), []);
});

test("runtimeInstalls: flags a code state that installs deps at runtime (the trace-mdhtml pattern)", () => {
  assert.ok(runtimeInstalls(`spawnSync('npm', ['install', library], { cwd: workDir })`).length > 0);
  assert.ok(runtimeInstalls("execSync(`npm install marked`)").length > 0);
  assert.ok(runtimeInstalls(`execSync('yarn add pdfkit')`).length > 0);
  // a static import is NOT an install
  assert.deepEqual(runtimeInstalls(`import marked from 'marked';`), []);
});

test("unawaitedShell: flags c.shell/ctx.shell without await (async-misuse guard), allows awaited", () => {
  assert.ok(unawaitedShell(`if (c.shell('npx tsc')) return 'FAIL';`).length > 0);   // bare → truthy Promise
  assert.ok(unawaitedShell(`const ok = ctx.shell('git status');`).length > 0);
  assert.deepEqual(unawaitedShell(`if (!await c.shell('npx tsc')) return 'FAIL';`), []);
  assert.deepEqual(unawaitedShell(`const ok = await ctx.shell('git status');`), []);
});

test("stripComments: erases line + block comments, PRESERVES strings/templates", () => {
  assert.equal(stripComments(`a; // npm install here\nb;`).includes("npm install"), false);
  assert.equal(stripComments(`a; /* require('x') */ b;`).includes("require"), false);
  assert.equal(stripComments(`const c = 'npm install x';`).includes("npm install x"), true);     // string kept
  assert.equal(stripComments("const u = `https://a//b`;").includes("https://a//b"), true);        // // in a string kept
});

/** The shipped regression: a COMMENT explaining that `npm install` is handled by setup.sh tripped runtimeInstalls,
 *  failing an otherwise-valid Expo-generator compile (and fix_verify couldn't fix a phantom). Comments are erased
 *  before the scan; a real install in a STRING is still caught. */
test("comment-immunity: a `// npm install …` comment does not trip runtimeInstalls; a real one still does", () => {
  const comment = `// npm install is handled by the manifest + setup.sh; not done at runtime`;
  assert.deepEqual(runtimeInstalls(stripComments(comment)), []);
  assert.ok(runtimeInstalls(stripComments(`execSync('npm install x'); // installs the dep`)).length > 0);
});

test("comment-immunity: comments mentioning require()/__dirname/os.tmpdir/'/tmp' don't trip their scanners", () => {
  assert.deepEqual(substrateViolations(stripComments(`// never use require() in an ESM lib`)), []);
  assert.deepEqual(workspaceEscapes(stripComments(`// write under c.out(), not /tmp or ~/cache`)), []);
  // but the real thing, in code, is still flagged after stripping
  assert.ok(substrateViolations(stripComments(`const x = require('pdfkit'); // load it`)).length > 0);
  assert.ok(workspaceEscapes(stripComments(`mkdirSync('/tmp/work'); // scratch`)).length > 0);
});
