import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { parseSkeletonXML } from "./xml.js";
import { typecheckGenerated } from "./typecheck.js";
import { commandAgentsDir } from "./project-fs.js";
import type { InputDecl } from "./schema.js";
import { layout } from "../layout.js";

/** reharness's OWN bundled tsx loader, as an absolute URL. The FSM-import probe (below) spawns a fresh `node` in the
 *  TARGET project's cwd; a bare `--import tsx/esm` would resolve tsx from THERE (and fail in a project without it).
 *  Resolving from reharness's install makes `verify` self-contained — a first `compile` in an empty dir just works. */
const TSX_ESM = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

/** Blank out comments while PRESERVING string/template literals. The substrate/escape scanners below are regex-over-
 *  source, so a `// npm install is handled by setup.sh` comment or a path named in a doc-comment would false-positive
 *  (this shipped: a comment explaining that npm install is NOT done at runtime tripped `runtimeInstalls`, failing an
 *  otherwise-valid compile). A REAL `c.shell('npm install x')` lives in a STRING and must still be caught, so strings
 *  are kept verbatim; only comments are erased. (Regex literals containing `//` aren't special-cased — worst case a
 *  missed detection on that line, never a false positive — so this only ever loosens, never tightens.) */
export function stripComments(src: string): string {
  return src.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : " "));
}

/** HARDCODED home/temp/absolute paths — non-parameterized, so they have no place in a code state: an
 *  inter-stage artifact lives under `c.out()`, and an external target the workflow operates on comes from a
 *  declared `<input>` via `c.config.<name>` (a `c.config`-derived path is a variable, not a literal, so it
 *  passes this check). What's rejected is baking a fixed location into the lib. Returns the offending tokens.
 *  A syntactic constraint (same category as the embedded-agent check), not a dataflow fixpoint. */
export function workspaceEscapes(libSource: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\b(?:os\.)?tmpdir\s*\(/, "os.tmpdir()"],
    [/\b(?:os\.)?homedir\s*\(/, "os.homedir()"],
    [/\bprocess\.env\.(?:TMPDIR|TMP|TEMP|HOME)\b/, "process.env.TMPDIR/HOME"],
    [/['"`]\s*\/(?:tmp|var|Users|home|private|opt|etc|root)(?:\/|['"`])/, "absolute system path literal"],
    [/['"`]~\//, "home (~/) path literal"],
  ];
  const hits = new Set<string>();
  for (const [re, label] of checks) if (re.test(libSource)) hits.add(label);
  return [...hits];
}

/** Substrate violations in a code state: spawning Node to **eval a script string** (`node -e` / `--eval`) is
 *  never the right tool — interpolating code into `-e` is fragile (shell+JS double-escaping) and leaks any
 *  interpolated secret on error; the safe alternative (in-process `vm`/`fetch`, or `node <file>`) is always
 *  available, so flagging `-e` removes no capability. We do NOT forbid spawning node a script FILE
 *  (`spawnSync('node', ['build.js'])`) — running an external/target script, or executing code via a written
 *  file, is legitimate. Only the eval-string form is flagged. */
export function substrateViolations(libSource: string): string[] {
  const hits = new Set<string>();
  // string form: `node -e …` / `node --eval …` (e.g. execSync(`node -e ${script}`))
  if (/\bnode\s+(?:-e|--eval)\b/.test(libSource)) hits.add("`node -e` (eval a constructed script string)");
  // array form: spawnSync('node', ['-e', …]) / ['--eval', …]
  if (/['"`]node['"`]\s*,\s*\[\s*['"`](?:-e|--eval)['"`]/.test(libSource)) hits.add("spawnSync('node', ['-e', …]) (eval a constructed script string)");
  // CommonJS-isms in an ESM module (the lib is `type: module`): these globals are simply undefined at runtime,
  // so they throw — and tsc can't see it (`require` is typed via @types/node). Flag the universal substrate slip.
  if (/\brequire\s*\(/.test(libSource) && !/\bcreateRequire\b/.test(libSource))
    hits.add("`require(...)` — this lib is ESM; use `import` / `await import('pkg')` (or `createRequire(import.meta.url)`)");
  if (/\b__dirname\b/.test(libSource)) hits.add("`__dirname` — ESM has none; derive paths from `import.meta.url` (or write under `c.out()`)");
  if (/\b__filename\b/.test(libSource)) hits.add("`__filename` — ESM has none; use `import.meta.url`");
  return [...hits];
}

/** A dependency loaded via a NON-LITERAL specifier (`await import(libName)` where `libName` is a variable). The
 *  manifest derives npm deps by scanning LITERAL import specifiers (`from 'x'`, `import('x')`), so a variable
 *  specifier means the package is never recorded, never installed by `setup.sh`, and the run fails at load. The
 *  fix is a DEFERRED literal import — `const x = await import('pkg')` — and to NOT make *which library* a runtime
 *  parameter (gratuitous machinery that also defeats provisioning). Returns the offending specifier expressions. */
export function unprovisionableImports(libSource: string): string[] {
  const hits = new Set<string>();
  // `import(` followed (after optional whitespace) by something that is NOT a quote → a variable/expression.
  for (const m of libSource.matchAll(/\bimport\s*\(\s*([^'"`)\s][^),]*)/g)) hits.add(m[1].trim().slice(0, 48));
  return [...hits];
}

/** A code state shelling out a package-manager INSTALL at runtime (`npm install pdfkit`, `yarn add …`). Deps are
 *  provisioned ONCE by the derived manifest + emitted `setup.sh` (scanned from static imports), so a runtime
 *  install is both redundant and a sign the dep is being treated as runtime-resolved (which then needs a dynamic
 *  import the manifest can't see). The fix is always to `import` the package by a literal specifier and let the
 *  manifest install it. Returns the offending install commands. */
export function runtimeInstalls(libSource: string): string[] {
  const hits = new Set<string>();
  // string form: execSync('npm install x') / `npm install ${x}`
  for (const m of libSource.matchAll(/\b(npm\s+(?:install|i|ci|add)|yarn\s+add|pnpm\s+(?:add|install))\b/g)) hits.add(m[1].replace(/\s+/g, " "));
  // array form: spawnSync('npm', ['install', …]) / spawnSync('yarn', ['add', …])
  for (const m of libSource.matchAll(/['"`](npm|yarn|pnpm)['"`]\s*,\s*\[\s*['"`](install|i|ci|add)\b/g)) hits.add(`${m[1]} ${m[2]}`);
  return [...hits];
}

/** An arg declared `default=""` whose value the lib uses as a filesystem PATH / write target — an empty default
 *  there resolves to nothing, so the pipeline writes its output nowhere (the trace-proofread / yaml-to-json
 *  output-default bug). An empty default on a genuinely OPTIONAL TEXT value (e.g. extra `context` concatenated
 *  into a prompt) is legitimate, so we flag ONLY a `c.config.<name>` that flows into a path-join / file-write
 *  call — precise, dataflow-grounded, no false positive on optional text. Returns the offending arg names. */
/** A `c.shell(...)` / `ctx.shell(...)` call that is not awaited. `c.shell` is async (`Promise<boolean>`), so an
 *  unawaited call yields a truthy Promise — `if (c.shell(...))` is always true, a silent bug. Returns the snippets. */
export function unawaitedShell(libSource: string): string[] {
  const hits = new Set<string>();
  for (const m of libSource.matchAll(/(await\s+)?\b(?:c|ctx)\.shell\s*\(/g)) if (!m[1]) hits.add(m[0].trim());
  return [...hits];
}

export function emptyOutputDefaults(inputs: InputDecl[] | undefined, libSource: string): string[] {
  const out: string[] = [];
  for (const a of inputs || []) {
    if ((a.type && a.type !== "string") || typeof a.default !== "string" || a.default.trim() !== "") continue;
    const inPathCall = new RegExp(`\\b(?:writeFileSync|writeFile|appendFileSync|createWriteStream|mkdirSync|mkdir|join|resolve)\\s*\\([^;\\n]*\\bc\\.config\\.${a.name}\\b`).test(libSource);
    if (inPathCall) out.push(a.name);
  }
  return out;
}

/** Check that a generated `reharness/` directory is structurally valid and the TS imports + FSM graph load. */
export function verifyGenerated(targetDir: string): string[] {
  const errors: string[] = [];
  const L = layout(targetDir);
  const commandsDir = L.commands;
  const agentsDir = L.agents;
  const libDir = L.lib;
  const skeletonsDir = L.skeletons;

  if (!existsSync(commandsDir)) return ["## Missing\n`reharness/commands/` does not exist"];

  const commandFiles = readdirSync(commandsDir).filter(f => f.endsWith(".ts"));
  if (commandFiles.length === 0) return ["## No commands\nNo `.ts` files in `reharness/commands/`"];

  // 1. Every skeleton's agent/code states must have filled prompts / implementations. Agents are namespaced per
  //    command: agents/<cmdId>/<name>/SYSTEM.md.
  for (const file of existsSync(skeletonsDir) ? readdirSync(skeletonsDir).filter(f => f.endsWith(".xml")) : []) {
    let sk;
    try { sk = parseSkeletonXML(readFileSync(resolve(skeletonsDir, file), "utf-8")); }
    catch (e: any) { errors.push(`## Invalid skeleton\n\`${file}\`: ${e.message}`); continue; }

    const sAgents = commandAgentsDir(L.root, sk.id);
    for (const [name, state] of Object.entries(sk.states)) {
      if (state.type !== "agent" && state.type !== "interactive") continue;
      const p = resolve(sAgents, name, "SYSTEM.md");
      if (!existsSync(p)) {
        errors.push(`## Missing agent prompt\n[${sk.id}] state \`${name}\` requires \`agents/${sk.id}/${name}/SYSTEM.md\``);
      } else if (readFileSync(p, "utf-8").includes("<!-- TODO")) {
        errors.push(`## Unfilled prompt\n[${sk.id}] \`agents/${sk.id}/${name}/SYSTEM.md\` is still a stub`);
      }
    }
    const libPath = resolve(libDir, `${sk.id}-states.ts`);
    if (existsSync(libPath)) {
      const lib = readFileSync(libPath, "utf-8");
      const todos = (lib.match(/\/\/\s*TODO/g) || []).length; // TODO lives in comments — scan raw source
      if (todos) errors.push(`## Unfilled code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` has ${todos} TODO(s)`);

      // Every check below is regex-over-source matching CODE, so scan with comments erased (strings kept) — a mention
      // of `npm install` / a path / `c.agent(...)` inside a comment is documentation, not a violation.
      const code = stripComments(lib);

      // Code states must be deterministic — they must NOT invoke agents. An embedded `c.agent('X')`
      // has no prompt file (codegen only creates prompts for declared agent states) and throws at runtime.
      const embedded = new Set<string>();
      for (const m of code.matchAll(/\b(?:c|ctx)\.agent\(\s*['"]([^'"]+)['"]/g)) embedded.add(m[1]);
      if (embedded.size) {
        errors.push(`## Embedded agent call in code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` calls c.agent(${[...embedded].map(n => `'${n}'`).join(", ")}) from a code state. Code states are deterministic and must not invoke agents — promote each LLM call to its own \`agent\` state (or a \`parallel\`/\`loop\` over an agent state).`);
      }

      // Workspace invariant: every artifact a stage produces must live under its run dir. Code states write
      // ONLY into c.out() and read upstream outputs via c.dir(); a temp/home/absolute path escapes the run.
      const escapes = workspaceEscapes(code);
      if (escapes.length) {
        errors.push(`## Workspace escape in code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` uses ${escapes.join(", ")}. A hardcoded home/temp/absolute path makes the workflow non-reusable. Two cases:\n- **Inter-stage artifact** (a scratch/intermediate file): write it under \`c.out()\` and read upstream outputs via \`c.dir('<stage>')\` — never a hand-built or absolute path, and never pass a filesystem path through \`ctx.data\` (scalars only).\n- **An external TARGET the workflow operates on** (the user's dotfiles dir, a target repo, a deploy/convert path): declare it as an \`<input>\` and use \`c.config.<name>\` (a \`c.config\`-derived path is allowed). Resolve any environment default (\`~\`/\`$HOME\`/cwd) at the command boundary, not in a code state.`);
      }

      const substrate = substrateViolations(code);
      if (substrate.length) {
        errors.push(`## Substrate violation in code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` uses ${substrate.join(", ")}. Never \`node -e\`/\`--eval\` a constructed script string (fragile escaping + leaks any interpolated secret). The entry function may be \`async\`: use \`await fetch(url, { headers })\` for HTTP (secret stays in the header, in memory), and \`spawnSync('git', [argv])\` for git. If you genuinely must run JS as a subprocess, write it to a file in \`c.out()\` and run \`node <file>\` (no \`-e\`). Implement the integration the relevant \`reharness/skills/*.md\` documents.`);
      }

      const unprov = unprovisionableImports(code);
      if (unprov.length) {
        errors.push(`## Unprovisionable dependency import\n[${sk.id}] \`lib/${sk.id}-states.ts\` loads a package via a non-literal specifier: \`import(${unprov.join("), import(")})\`. The dependency manifest is derived by scanning LITERAL import specifiers, so a variable specifier is never installed and the run fails at load. Load the dependency with a DEFERRED literal import inside the function — \`const pdf = (await import('pdfkit')).default\` — so the manifest records it AND the module still loads when the dep isn't installed yet (a top-level \`import pdf from 'pdfkit'\` fails verification because it resolves the package at load time, before \`setup.sh\` runs). Do NOT make *which library* a runtime parameter (\`config\`/\`data\`); a compiled pipeline targets the one library the session used.`);
      }

      const installs = runtimeInstalls(code);
      if (installs.length) {
        errors.push(`## Runtime dependency install in code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` runs \`${installs.join("`, `")}\` at runtime. Dependencies are provisioned ONCE by the derived manifest + emitted \`setup.sh\` (built from your literal import specifiers) — a code state must never install packages itself. Load the package with a deferred literal import (\`const pdf = (await import('pdfkit')).default\`) so the manifest records and installs it; delete the runtime install and any "write a script then dynamically import it" scaffolding.`);
      }

      const unawaited = unawaitedShell(code);
      if (unawaited.length) {
        errors.push(`## Un-awaited c.shell in code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` calls \`${unawaited.join("`, `")}\` without \`await\`. \`c.shell\` is async (\`Promise<boolean>\`): an un-awaited call returns a truthy Promise, so \`if (c.shell(...))\` is always true and the command's success is never checked (and it cannot be interrupted by a timeout/abort if not awaited). Write \`await c.shell(...)\`; the entry is already \`async\`.`);
      }

      const emptyOut = emptyOutputDefaults(sk.inputs, code);
      if (emptyOut.length) {
        errors.push(`## Empty default on an output path\n[${sk.id}] arg(s) ${emptyOut.map(n => `\`${n}\``).join(", ")} declare \`default=""\` but the lib uses \`c.config.<name>\` as a filesystem path / write target — an empty default resolves to nothing, so the pipeline writes its output nowhere. Give each a concrete default (e.g. \`default="report.md"\`, the filename the demonstration showed) in the skeleton \`<inputs>\`, or make it \`required="true"\`. (This is a skeleton \`<arg>\` change — if you cannot edit it as a leaf, escalate.)`);
      }
    }
  }

  // 2. TypeScript compile — in-process against our pinned TS (no `npx tsc`, no dependence on the target's
  //    toolchain; a generated project ships neither tsconfig nor a local tsc, so the old subprocess did nothing).
  errors.push(...typecheckGenerated(targetDir));

  // 3. Each command imports cleanly. A null return from run() is valid (command may require specific args).
  for (const file of commandFiles) {
    const path = resolve(commandsDir, file);
    const script = `import cmd from '${path}';
if (!cmd?.run) { console.error('no run()'); process.exit(1); }
cmd.run(['probe', 'arg2', 'arg3'], { root: '${targetDir}', agents: '${agentsDir}', cwd: '${targetDir}' });`;
    try {
      execFileSync("node", ["--import", TSX_ESM, "-e", script], { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      errors.push(`## FSM validation: ${file}\n\`\`\`\n${(err.stdout || err.stderr || err.message).slice(0, 2000)}\n\`\`\``);
    }
  }

  return errors;
}
