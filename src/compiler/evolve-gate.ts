import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { workspaceEscapes, substrateViolations } from "./verify.js";

/**
 * Acquisition gate for a synthesized tool — the EBL-extracted routine frozen into a NEUTRAL routine module
 * `<name>.routine.mjs` (exports `{ tool, run }`; backend wrappers are rendered deterministically from it, so the
 * gate is backend-agnostic). A tool is kept only if correct-by-construction here; whether it's WORTH keeping
 * (utility) is the separate retention gate (the ledger). Checks, all cheap/static + one self-test run (LATM-style):
 *  1. parses (`node --check`);
 *  2. is a neutral routine (exports `run` + a `tool` descriptor);
 *  3. substrate-safe (no node-eval / secrets-in-shell / workspace escape — same rules as generated lib);
 *  4. its self-test (`<name>.test.mjs`) passes, if present (behaviour preservation).
 * Returns the list of problems (empty = admit the tool). The descriptor's name/schema and the filename==tool.name
 * invariant the runtime relies on are checked at bind (reconcile_tools), which imports the module anyway.
 */
export function verifyTool(routinePath: string): string[] {
  const errs: string[] = [];
  if (!existsSync(routinePath)) return [`tool routine missing: ${routinePath}`];
  const src = readFileSync(routinePath, "utf-8");

  // 1. parses
  try { execFileSync("node", ["--check", routinePath], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 }); }
  catch (e: any) { errs.push(`syntax error: ${(e.stderr || e.message || "").toString().slice(0, 500)}`); }

  // 2. is a neutral routine module
  if (!/export\s+(async\s+)?function\s+run\b|export\s+(const|let)\s+run\b/.test(src)) errs.push("no exported `run` (the frozen routine)");
  if (!/export\s+const\s+tool\b/.test(src)) errs.push("no exported `tool` descriptor ({ name, description, schema })");

  // 3. substrate-safe
  const esc = workspaceEscapes(src), sub = substrateViolations(src);
  if (esc.length) errs.push(`workspace escape: ${esc.join(", ")}`);
  if (sub.length) errs.push(`substrate violation: ${sub.join(", ")}`);

  // 4. self-test (behaviour preservation), if the extractor wrote one
  const testPath = routinePath.replace(/\.routine\.mjs$/, ".test.mjs");
  if (existsSync(testPath)) {
    try { execFileSync("node", [testPath], { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 }); }
    catch (e: any) { errs.push(`self-test failed: ${(e.stdout || e.stderr || e.message || "").toString().slice(0, 500)}`); }
  }

  return errs;
}
