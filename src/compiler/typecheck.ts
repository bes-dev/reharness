import ts from "typescript";
import { existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { layout } from "../layout.js";

/** Package root: this file is dist/compiler/typecheck.js → ../.. is the reharness package root, which holds
 *  dist/ (our own `.d.ts` for the `reharness` import). */
const REHARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The node_modules/@types directory that holds our @types/node, resolved from THIS module so it is found
 *  regardless of install layout (hoisted or nested). undefined if absent (best-effort). */
const NODE_TYPES_ROOT = (() => {
  try { return resolve(dirname(createRequire(import.meta.url).resolve("@types/node/package.json")), ".."); }
  catch { return undefined; }
})();

/**
 * Type-check a generated pipeline IN-PROCESS, against our own pinned TypeScript — no `npx tsc`, no dependence on
 * the target project having TypeScript or a tsconfig installed (a generated project has neither, so the old
 * subprocess check silently did nothing). Options are synthesised to match the standardised generated code:
 * ES2022 + Node16 ESM (so `import … from '../lib/x.js'` resolves to the `.ts`), the `reharness` import mapped to
 * our own dist types via `paths` (resolves even when the target lacks a node_modules/reharness symlink), and Node
 * globals from our bundled @types/node. Returns one markdown error block when the program has diagnostics, else [].
 */
export function typecheckGenerated(targetDir: string): string[] {
  const root = layout(targetDir).root;
  const files: string[] = [];
  for (const sub of ["commands", "lib"]) {
    const d = resolve(root, sub);
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith(".ts")) files.push(resolve(d, f));
  }
  if (files.length === 0) return [];

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    strict: false, noImplicitAny: false, esModuleInterop: true, skipLibCheck: true, noEmit: true,
    types: ["node"],
    ...(NODE_TYPES_ROOT ? { typeRoots: [NODE_TYPES_ROOT] } : {}),
    baseUrl: REHARNESS_ROOT,
    paths: {
      "reharness": ["dist/index.d.ts"],
      "reharness/runtime": ["dist/runtime/index.d.ts"],
      "reharness/compiler": ["dist/compiler/index.d.ts"],
    },
  };

  // A missing RELATIVE module is a real bug in the generated code; a missing BARE (npm) module is a
  // provisioning concern — the capability manifest surfaces it and the emitted setup.sh installs it, so it
  // must NOT hard-fail verify (keeps compile cheap, doesn't force an install to pass).
  const diags = ts.getPreEmitDiagnostics(ts.createProgram(files, options)).filter(d => {
    if (d.code !== 2307) return true; // TS2307 = "Cannot find module 'X'"
    const spec = /Cannot find module '([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, "\n"))?.[1];
    return !spec || spec.startsWith(".") || spec.startsWith("/"); // keep relative/absolute; tolerate bare
  });
  if (diags.length === 0) return [];
  const text = ts.formatDiagnostics(diags, {
    getCanonicalFileName: f => f,
    getCurrentDirectory: () => targetDir,
    getNewLine: () => "\n",
  });
  return [`## TypeScript errors\n\`\`\`\n${text.slice(0, 2000)}\n\`\`\``];
}
