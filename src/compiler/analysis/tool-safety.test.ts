import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSafetyErrors } from "./tool-safety.js";
import type { ToolDecl } from "../schema.js";

const tool = (effect?: string): ToolDecl[] => [{ name: "t", effect }];

test("pure tool with pure body → clean", () => {
  const src = `export default (pi)=>pi.registerTool({execute(){ const x = JSON.parse("{}"); return x; }})`;
  assert.deepEqual(toolSafetyErrors("s", tool(), src), []);
});

test("file read without ReadWorkspace effect → flagged", () => {
  const src = `import {readFileSync} from "fs"; const x = readFileSync(p);`;
  const errs = toolSafetyErrors("s", tool(), src);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /file read.*ReadWorkspace/);
});

test("file read WITH ReadWorkspace effect → clean", () => {
  const src = `const x = readFileSync(p);`;
  assert.deepEqual(toolSafetyErrors("s", tool("ReadWorkspace"), src), []);
});

test("WriteWorkspace implies ReadWorkspace (write+read body) → clean", () => {
  const src = `readFileSync(a); writeFileSync(b, x);`;
  assert.deepEqual(toolSafetyErrors("s", tool("WriteWorkspace"), src), []);
});

test("shell without Shell effect → flagged", () => {
  const src = `import {execSync} from "child_process"; execSync("ls");`;
  const errs = toolSafetyErrors("s", tool("ReadWorkspace"), src);
  assert.ok(errs.some(e => /shell.*Shell/.test(e)));
});

test("eval is forbidden under ANY effect", () => {
  const src = `eval(userInput);`;
  const errs = toolSafetyErrors("s", tool("Shell"), src);
  assert.ok(errs.some(e => /eval\(\)/.test(e)));
});

test("process.env is forbidden (ambient secrets)", () => {
  const src = `const k = process.env.SECRET;`;
  assert.ok(toolSafetyErrors("s", tool("Net"), src).some(e => /process\.env/.test(e)));
});

test("union of effects across tools in one extension forms the budget", () => {
  const tools: ToolDecl[] = [{ name: "a", effect: "ReadWorkspace" }, { name: "b", effect: "Net" }];
  const src = `readFileSync(p); fetch(u);`;
  assert.deepEqual(toolSafetyErrors("s", tools, src), []);
});
