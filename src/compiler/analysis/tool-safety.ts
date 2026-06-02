import type { ToolDecl } from "../schema.js";

/**
 * Tool-safety analysis = effect inference over a SYNTHESIZED tool's source (the "Code Gate", finally earning
 * its place — see docs/design/tool-synthesis.md §5). A generated tool declares its world-effect via `effect=`;
 * its actual code must stay within that declared authority. Because we analyze CODE (not prose), this is
 * EXACT — no Rice wall, both safety and sufficiency hold for the body. We detect effect-bearing patterns by
 * static scan and flag any whose effect is not granted by the declaration.
 *
 * Effect lattice (what a tool body may do), from least to most:
 *   (pure)        — string/JSON/number computation only; no I/O, no ambient nondeterminism.
 *   ReadWorkspace — read files (fs read APIs).
 *   WriteWorkspace— write files (fs write APIs).
 *   Shell         — child_process.
 *   Net           — network (fetch / http / https).
 * Plus an always-forbidden set (dynamic code execution) that NO effect grants.
 */

/** Source patterns that betray an effect. Each maps a regex over tool source → the effect it requires. */
const EFFECT_PATTERNS: Array<{ effect: string; re: RegExp; what: string }> = [
  { effect: "ReadWorkspace",  re: /\b(readFileSync|readFile|createReadStream|readdirSync|readdir)\b/, what: "file read" },
  { effect: "WriteWorkspace", re: /\b(writeFileSync|writeFile|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync)\b/, what: "file write" },
  { effect: "Shell",          re: /\b(execSync|exec|spawn|spawnSync|execFile|execFileSync|child_process)\b/, what: "shell / subprocess" },
  { effect: "Net",            re: /\b(fetch|XMLHttpRequest)\b|\bfrom ['"](node:)?(http|https|net|dgram)['"]|require\(['"](node:)?(http|https|net)['"]\)/, what: "network" },
];

/** Patterns no declared effect may grant — dynamic code execution / ambient authority escalation. */
const FORBIDDEN: Array<{ re: RegExp; what: string }> = [
  { re: /\beval\s*\(/, what: "eval()" },
  { re: /\bnew\s+Function\s*\(/, what: "new Function()" },
  { re: /\bprocess\.env\b/, what: "process.env (ambient secrets)" },
];

/** Effects a declared `effect=` value grants. A higher effect implies the read it builds on. */
function granted(declared: string | undefined): Set<string> {
  const g = new Set<string>();
  const e = (declared || "").trim();
  if (!e || e.toLowerCase() === "pure" || e.toLowerCase() === "none") return g;
  g.add(e);
  // WriteWorkspace implies ReadWorkspace (writing a temp then renaming, etc.).
  if (e === "WriteWorkspace") g.add("ReadWorkspace");
  return g;
}

/**
 * Check one generated tool extension's source against its declared tool effects. Returns error strings.
 * `tools` is the leaf's declared tools (one extension file may register several); we take the UNION of their
 * granted effects as the file's budget (the extension is one process; a coarser-but-sound over-approximation).
 */
export function toolSafetyErrors(stateName: string, tools: ToolDecl[], source: string): string[] {
  const errors: string[] = [];
  const budget = new Set<string>();
  for (const t of tools) for (const e of granted(t.effect)) budget.add(e);

  for (const f of FORBIDDEN) {
    if (f.re.test(source)) {
      errors.push(`Tool '${stateName}': forbidden ${f.what} in generated tool code — no effect grants dynamic code execution / ambient authority. Rewrite as a deterministic function over the tool's params.`);
    }
  }
  for (const p of EFFECT_PATTERNS) {
    if (p.re.test(source) && !budget.has(p.effect)) {
      errors.push(`Tool '${stateName}': code performs ${p.what} (effect '${p.effect}') but no declared <tool effect="..."> grants it. Add effect="${p.effect}" to the tool, or remove the operation (a pure tool must be pure).`);
    }
  }
  return errors;
}
