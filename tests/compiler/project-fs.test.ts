import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, lstatSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { ensureESMPackage, loadSkeletons } from "../../src/compiler/project-fs.js";

/** #5: a DANGLING reharness symlink (target deleted) must be detected and recreated, not left in place
 *  (lstat().isSymbolicLink() is true even for broken links). */
test("#5 ensureESMPackage replaces a broken reharness symlink", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-fs-"));
  try {
    const nm = resolve(dir, "node_modules");
    mkdirSync(nm, { recursive: true });
    const link = resolve(nm, "reharness");
    symlinkSync(resolve(dir, "does-not-exist"), link, "dir"); // dangling
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.ok(!existsSync(link)); // broken: target missing

    ensureESMPackage(dir, "tmp-test");

    assert.ok(existsSync(link), "symlink should now resolve to the real reharness root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureESMPackage makes the bundle npm-installable: declares reharness as a versioned dependency", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-pkg-"));
  try {
    ensureESMPackage(dir, "my-bundle");
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8"));
    assert.equal(pkg.type, "module");
    assert.match(pkg.dependencies?.reharness ?? "", /^[\^~]?\d|\*/, "depends on a real reharness version → `npm install` resolves it off-machine");
    // idempotent + non-destructive: a re-run keeps an existing (e.g. user-edited) reharness spec
    const pkgPath = resolve(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, dependencies: { reharness: "file:../local", expo: "^50" } }, null, 2));
    ensureESMPackage(dir, "my-bundle");
    const pkg2 = JSON.parse(readFileSync(pkgPath, "utf-8"));
    assert.equal(pkg2.dependencies.reharness, "file:../local", "existing reharness spec preserved");
    assert.equal(pkg2.dependencies.expo, "^50", "other deps preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSkeletons: parses every *.xml, skips unparseable + non-xml, [] when dir absent", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "rh-sk-"));
  try {
    const skDir = resolve(dir, "skeletons");
    assert.deepEqual(loadSkeletons(skDir), [], "missing dir → []");
    mkdirSync(skDir, { recursive: true });
    const ok = (id: string) =>
      `<skeleton id="${id}" initial="s" format-version="0.5"><description>d</description><usage>u</usage>` +
      `<state name="s" type="final" status="success" /></skeleton>`;
    writeFileSync(resolve(skDir, "a.xml"), ok("a"));
    writeFileSync(resolve(skDir, "b.xml"), ok("b"));
    writeFileSync(resolve(skDir, "broken.xml"), "<skeleton not closed");
    writeFileSync(resolve(skDir, "notes.txt"), ok("ignored")); // non-xml → not read
    assert.deepEqual(loadSkeletons(skDir).map(s => s.id).sort(), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
