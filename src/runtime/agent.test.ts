import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessArgs } from "./agent.js";

const base = { prompt: "p", task: "t", cwd: "/tmp" };

test("no harness ⇒ no flags (backward compatible)", () => {
  assert.deepEqual(harnessArgs(base), []);
});

test("lowers each harness axis to its Pi flag", () => {
  assert.deepEqual(
    harnessArgs({ ...base, thinking: "high", tools: ["read", "ls"],
                  extensions: ["/x/tools.ts"], skills: ["/s/foo"], noContextFiles: true }),
    ["--thinking", "high", "--tools", "read,ls", "--extension", "/x/tools.ts", "--skill", "/s/foo", "--no-context-files"],
  );
});

test("multiple extensions/skills each get their own flag", () => {
  assert.deepEqual(
    harnessArgs({ ...base, extensions: ["/a.ts", "/b.ts"] }),
    ["--extension", "/a.ts", "--extension", "/b.ts"],
  );
});

test("empty arrays emit nothing", () => {
  assert.deepEqual(harnessArgs({ ...base, tools: [], extensions: [] }), []);
});
