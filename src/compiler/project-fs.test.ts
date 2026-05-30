import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, lstatSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { ensureESMPackage } from "./project-fs.js";

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
