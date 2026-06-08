import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { externalDeps, externalTools, externalEnv, deriveManifest, writeSetupScript, writeDockerfile } from "../../src/compiler/manifest.js";

test("externalDeps: bare npm only — builtins/relative/reharness excluded, subpaths + scopes collapsed", () => {
  const src = `import { writeFileSync } from 'fs';
import { resolve } from 'node:path';
import { defineCommand } from 'reharness';
import PDFDocument from 'pdfkit';
import sub from '@scope/pkg/sub/mod';
import rel from '../../src/lib/helper.js';
const merge = await import('lodash/merge');
const legacy = require('legacy-pkg');`;
  // require() is a substrate bug (caught by verify), but the dep it names is still real → manifest lists it
  assert.deepEqual(externalDeps(src).sort(), ["@scope/pkg", "legacy-pkg", "lodash", "pdfkit"]);
});

test("externalTools: CLI binaries from spawn/exec, minus toolchain/shell builtins", () => {
  const src = `spawnSync('ffmpeg', ['-i', x]);
execSync('git clone ' + url);
execFileSync('pandoc', [a, b]);
spawnSync('node', ['build.js']);   // toolchain — excluded
execSync('mkdir -p ' + d);         // shell builtin — excluded`;
  assert.deepEqual(externalTools(src).sort(), ["ffmpeg", "git", "pandoc"]);
});

test("externalEnv: process.env reads, minus ambient vars", () => {
  const src = `const t = process.env.GITHUB_TOKEN; const k = process.env['OPENAI_API_KEY']; const h = process.env.HOME;`;
  assert.deepEqual(externalEnv(src).sort(), ["GITHUB_TOKEN", "OPENAI_API_KEY"]); // HOME is ambient → excluded
});

test("deriveManifest: writes reharness/manifest.json with the full inventory (npm + tools + env)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-man-"));
  try {
    const rh = resolve(dir, "reharness");
    mkdirSync(resolve(rh, "lib"), { recursive: true });
    writeFileSync(resolve(rh, "lib", "a-states.ts"), `import PDF from 'pdfkit';\nimport { readFileSync } from 'fs';\nspawnSync('git', ['clone']);`);
    writeFileSync(resolve(rh, "lib", "b-states.ts"), `const x = await import('marked');\nconst t = process.env.API_KEY;`);
    const m = deriveManifest(rh);
    assert.deepEqual(m.npm, ["marked", "pdfkit"]);
    assert.deepEqual(m.tools, ["git"]);
    assert.deepEqual(m.env, ["API_KEY"]);
    assert.ok(existsSync(resolve(rh, "manifest.json")));
    assert.deepEqual(JSON.parse(readFileSync(resolve(rh, "manifest.json"), "utf-8")).tools, ["git"]);
    // deriveManifest also renders the runnable setup.sh (the user installs deps themselves; the compiler never does)
    const setup = readFileSync(resolve(rh, "setup.sh"), "utf-8");
    assert.match(setup, /npm install marked pdfkit/);
    assert.match(setup, /install_tool git/);                  // cross-platform tool install
    assert.match(setup, /brew install|apt-get install/);      // package-manager detection present
    assert.match(setup, /export API_KEY/);
    // renderer 2: the reproducible container — DELEGATES install to setup.sh (one source), so it's static
    const dockerfile = readFileSync(resolve(rh, "Dockerfile"), "utf-8");
    assert.match(dockerfile, /^FROM node:/m);
    assert.match(dockerfile, /RUN bash reharness\/setup\.sh/);  // no duplicated apt/npm lines
    assert.doesNotMatch(dockerfile, /apt-get install/);          // install logic lives ONLY in setup.sh
    assert.match(dockerfile, /-e API_KEY/);                       // env passed to `docker run`
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeDockerfile: static template that delegates install to setup.sh; entrypoint is reharness", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-docker-"));
  try {
    const df = readFileSync(writeDockerfile(dir, { npm: ["pdfkit"], tools: ["ffmpeg"], env: ["TOKEN"] }), "utf-8");
    assert.match(df, /^FROM node:/m);
    assert.match(df, /RUN bash reharness\/setup\.sh/);
    assert.doesNotMatch(df, /ffmpeg|pdfkit/);              // per-pipeline deps are in setup.sh, not the Dockerfile
    assert.match(df, /ENTRYPOINT \["reharness"\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeSetupScript: empty manifest → a no-op marker, returns null", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-setup-"));
  try {
    assert.equal(writeSetupScript(dir, { npm: [], tools: [], env: [] }), null);
    assert.match(readFileSync(resolve(dir, "setup.sh"), "utf-8"), /no external dependencies/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
