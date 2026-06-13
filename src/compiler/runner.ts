import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "fs";
import { resolve, relative } from "path";
import { buildGeneratePipeline } from "./generate.js";
import { parseSkeletonXML } from "./xml.js";
import { loadSkeletonIds, commandAgentsDir } from "./project-fs.js";
import { toMermaid, toHtml } from "./visualize.js";
import { layout } from "../layout.js";
import { buildEnhancePipeline } from "./enhance.js";
import { buildEvolvePipeline } from "./evolve.js";
import type { ApprovalHandler } from "../runtime/types.js";
import { ansi, emit } from "../term.js";

export interface RunGenerateOptions {
  cwd: string;
  input: string;
  autoApprove?: boolean;
  piModel?: string;
  fast?: boolean;
  noEnhance?: boolean;
  amend?: boolean;
  /** User-chosen command name (`--name`, compile only). Overrides the auto-derived skeleton id. */
  name?: string;
  /** Amend target command (multi-command). Empty ⇒ the sole command. */
  command?: string;
  /** `compile --from-session <path>`: a recorded session (file or dir, ANY format) to distil into a pipeline. */
  fromSession?: string;
  /** `compile --from-harness <dir>`: an existing harness/implementation directory the `research` agent explores
   *  IN PLACE (reads the orchestration spec, follows subagent refs to agent defs, reads skills) — a first-class
   *  grounding source alongside a request/session, not flattened. */
  fromHarness?: string;
  /** Absolute harness dir (resolved from fromHarness) injected into the pipeline config as `config.harness`. */
  harness?: string;
  /** Per-run hyperparameter overrides (`--param state.knob=value`) — applies to the compiler pipeline itself. */
  overrides?: Record<string, number>;
  /** Agent backend ("pi" | "claude") for the compiler pipeline — compile is token-heavy, so a Claude Code
   *  subscription is most valuable here. */
  provider?: string;
  /** Set internally once the session is staged — routes the pipeline to the distill front. */
  session?: boolean;
}

/** Normalise a user-supplied command name to a valid skeleton id (kebab-case), or null if it can't be. */
export function sanitizeCommandName(raw: string): string | null {
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(id) ? id : null;
}

/** Read a session source for distillation: a file verbatim, or a directory's text files concatenated with
 *  path headers. Format-agnostic — the bytes go straight to the distill agent (the LLM is the parser). */
export function readSessionInput(path: string): string {
  if (statSync(path).isFile()) return readFileSync(path, "utf-8");
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) walk(full);
      else { try { parts.push(`===== ${relative(path, full)} =====\n${readFileSync(full, "utf-8")}`); } catch { /* skip unreadable/binary */ } }
    }
  };
  walk(path);
  return parts.join("\n\n");
}

/** Render a compiled command's FSM as a graph (`graph` verb) — a deterministic pass, no model call. Default emits a
 *  Mermaid `flowchart` (GitHub/markdown-renderable); `--html` emits a self-contained interactive viewer. Writes to a
 *  file named after the command (`<id>.mmd` / `<id>.html`) by default; `--output <file>` overrides the name, and
 *  `--output -` streams to stdout (for piping into a markdown doc). */
export async function runGraph(opts: { cwd: string; command?: string; html?: boolean; out?: string }): Promise<number> {
  const L = layout(opts.cwd);
  if (!existsSync(L.skeletons)) {
    console.error("No compiled commands here (reharness/skeletons missing). Run `reharness compile <description>` first.");
    return 1;
  }
  const ids = loadSkeletonIds(L.skeletons);
  const id = opts.command || (ids.length === 1 ? ids[0] : undefined);
  if (!id || !ids.includes(id)) {
    console.error(id ? `Unknown command: ${id}` : "Name a command to graph.");
    console.error(`Available: ${ids.join(", ")}`);
    return 1;
  }
  const sk = parseSkeletonXML(readFileSync(resolve(L.skeletons, `${id}.xml`), "utf-8"));

  let output: string;
  if (opts.html) {
    const agentsDir = commandAgentsDir(L.root, id); // read each agent's prompt for the click panel
    const bodies: Record<string, string> = {};
    for (const [name, st] of Object.entries(sk.states)) {
      if (st.type !== "agent") continue;
      const p = resolve(agentsDir, name, "SYSTEM.md");
      if (existsSync(p)) bodies[name] = readFileSync(p, "utf-8");
    }
    output = toHtml(sk, bodies);
  } else {
    output = toMermaid(sk);
  }

  if (opts.out === "-") { console.log(output); return 0; } // explicit stdout — for piping into a doc
  const file = resolve(opts.cwd, opts.out || `${id}.${opts.html ? "html" : "mmd"}`);
  writeFileSync(file, output);
  console.log(`${ansi.green("✓")} wrote ${relative(opts.cwd, file)}`);
  return 0;
}

/** Amend an existing pipeline from a feature request (`amend` verb): same machinery as compile, but the amend
 *  front (load_amend → amend_prd → review_prd → amend_design) instead of a from-scratch design. */
export async function runAmend(opts: RunGenerateOptions): Promise<number> {
  const skeletonsDir = layout(opts.cwd).skeletons;
  if (!existsSync(skeletonsDir)) {
    console.error("Nothing to amend here (reharness/skeletons missing). Run `reharness compile <description>` first.");
    return 1;
  }
  // Selector: `amend <cmdId> <request>` — if the first word names an existing command, it's the target.
  const ids = new Set(loadSkeletonIds(skeletonsDir));
  const words = opts.input.trim().split(/\s+/);
  let command = "", input = opts.input;
  if (words.length > 1 && ids.has(words[0])) { command = words[0]; input = words.slice(1).join(" "); }
  return runCompile({ ...opts, input, command, amend: true });
}

/** Compile a pipeline (`compile` verb). Two front-ends share the PRD spine: from a DESCRIPTION (the default),
 *  or from a recorded SESSION (`--from-session <path>` — staged here, distilled in the pipeline). */
export async function runCompile(opts: RunGenerateOptions): Promise<number> {
  const verb = opts.amend ? "amend" : "compile";
  // Session front: stage the raw session at the scratch session.md and route the pipeline to distill. The session
  // IS the input, so a description is optional here (it becomes a generalisation hint).
  if (opts.fromSession) {
    if (!existsSync(opts.fromSession)) { console.error(`No session at "${opts.fromSession}".`); return 1; }
    const text = readSessionInput(opts.fromSession);
    if (!text.trim()) { console.error(`Session at "${opts.fromSession}" is empty (no readable text).`); return 1; }
    const genDir = layout(opts.cwd).scratch;
    mkdirSync(genDir, { recursive: true });
    writeFileSync(resolve(genDir, "session.md"), text);
    opts = { ...opts, session: true };
  }
  // Harness front: a directory the `research` agent explores IN PLACE (not staged/flattened). Resolve to an
  // absolute path and inject into config.harness; the harness alone is a valid input (it IS the workflow spec),
  // so synthesise a default description when none is given. Composes with a request/session (extra grounding).
  if (opts.fromHarness) {
    if (!existsSync(opts.fromHarness) || !statSync(opts.fromHarness).isDirectory()) { console.error(`No harness directory at "${opts.fromHarness}".`); return 1; }
    opts = { ...opts, harness: resolve(opts.fromHarness) };
    if (!opts.input.trim() && !opts.session) opts = { ...opts, input: `Compile the workflow implemented by the provided harness into a reharness pipeline, preserving its orchestration, per-step agents, and skills.` };
  }
  if (!opts.input.trim() && !opts.session && !opts.harness) {
    console.error(`Usage: reharness ${verb} <${opts.amend ? "what to add or change" : "description"}>`); return 1;
  }
  if (opts.name !== undefined) {
    const id = sanitizeCommandName(opts.name);
    if (!id) { console.error(`Invalid --name "${opts.name}" — use a command name like \`my-workflow\` (lowercase letters/digits/hyphens, starting with a letter).`); return 1; }
    opts = { ...opts, name: id };
  }
  process.on("SIGINT", () => { process.stdout.write("\r\x1b[K"); process.exit(130); });

  const pipeline = buildGeneratePipeline(opts);
  try {
    const status = await pipeline.run(emit, {
      autoApprove: opts.autoApprove,
      approvalHandler: terminalApprovalHandler,
      piModel: opts.piModel,
      overrides: opts.overrides,
      provider: opts.provider,
    });
    process.stdout.write("\r\x1b[K");
    console.log(status === "success" ? ansi.green(`✓ ${verb} complete`) : ansi.red(`✗ ${status}`));
    if (status !== "success") return 1;
    // Auto-chain the enhance layer as a SEPARATE gated pipeline (skippable). A failure here never invalidates
    // the verified base — compile already succeeded — so we always return 0. Scope it to the command we just
    // built (the draft scratch holds its id) so we don't disturb already-enhanced sibling commands.
    if (!opts.fast && !opts.noEnhance) await runEnhance({ cwd: opts.cwd, piModel: opts.piModel, command: compiledCommandId(opts.cwd), provider: opts.provider });
    return 0;
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${ansi.red("✗ crashed:")} ${err.message}`);
    return 1;
  }
}

/** The command just compiled/amended = the id in the draft scratch (construct/load_amend write the target there). */
function compiledCommandId(cwd: string): string {
  try { return parseSkeletonXML(readFileSync(resolve(layout(cwd).scratch, "draft-skeleton.xml"), "utf-8")).id; }
  catch { return ""; } // unreadable ⇒ enhance every leaf (safe fallback)
}

/** Run the enhance layer over an already-compiled pipeline (auto-chained after compile/amend unless --fast/--no-enhance).
 *  Not a verb — `enhance` was removed from the CLI surface; only `runCompile` chains it. */
async function runEnhance(opts: { cwd: string; piModel?: string; command?: string; provider?: string }): Promise<number> {
  if (!existsSync(layout(opts.cwd).skeletons)) {
    console.error("No compiled pipeline here (reharness/skeletons missing). Run `reharness compile <description>` first.");
    return 1;
  }
  try {
    const status = await buildEnhancePipeline(opts.cwd, opts.command).run(emit, { piModel: opts.piModel, provider: opts.provider });
    process.stdout.write("\r\x1b[K");
    console.log(status === "success" ? ansi.green("✓ enhance complete") : ansi.red(`✗ ${status}`));
    return status === "success" ? 0 : 1;
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${ansi.red("✗ enhance crashed:")} ${err.message}`);
    return 1;
  }
}

/** Run the evolve layer (v1 self-heal) over a compiled pipeline: read the last run's verdict and, if it failed,
 *  diagnose + repair the leaf; if it succeeded, report stability. The `reharness evolve` verb. */
export async function runEvolve(opts: { cwd: string; piModel?: string; command?: string; overrides?: Record<string, number>; provider?: string }): Promise<number> {
  const skeletonsDir = layout(opts.cwd).skeletons;
  if (!existsSync(skeletonsDir)) {
    console.error("No compiled pipeline here (reharness/skeletons missing). Run `reharness compile <description>` first.");
    return 1;
  }
  if (opts.command) { // `evolve <command>`: reject an unknown selector up front (mirrors amend's validation)
    const ids = loadSkeletonIds(skeletonsDir);
    if (!ids.includes(opts.command)) { console.error(`Unknown command "${opts.command}". Available: ${ids.join(", ")}`); return 1; }
  }
  try {
    const status = await buildEvolvePipeline(opts.cwd, opts.command, { provider: opts.provider, piModel: opts.piModel }).run(emit, { piModel: opts.piModel, overrides: opts.overrides, provider: opts.provider });
    process.stdout.write("\r\x1b[K");
    console.log(status === "success" ? ansi.green("✓ evolve complete") : ansi.red(`✗ ${status}`));
    return status === "success" ? 0 : 1;
  } catch (err: any) {
    process.stdout.write("\r\x1b[K");
    console.log(`${ansi.red("✗ evolve crashed:")} ${err.message}`);
    return 1;
  }
}

export const terminalApprovalHandler: ApprovalHandler = async (cp) => {
  const { dim, bold, cyan, red } = ansi;
  const sep = dim("─".repeat(60));
  console.log(`\n${sep}\n${bold(cyan("◆ APPROVAL"))} ${dim(`(${cp.state}, round ${cp.round})`)}\n\n${cp.prompt}\n`);
  for (const a of cp.artifacts) {
    console.log(dim(`── ${a.path} ──`));
    console.log(a.content.length > 4000 ? a.content.slice(0, 4000) + dim("\n[…truncated]") : a.content);
    console.log("");
  }
  console.log(`Events: ${cp.events.map(e => e === cp.autoEvent ? bold(e) : e).join(" | ")}\n${sep}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  try {
    while (true) {
      const ev = ((await ask(`Event [${cp.autoEvent || cp.events[0]}]: `)).trim()) || cp.autoEvent || cp.events[0];
      if (!cp.events.includes(ev)) { console.log(red(`Unknown event "${ev}". Allowed: ${cp.events.join(", ")}`)); continue; }
      return { event: ev };
    }
  } finally { rl.close(); }
};
