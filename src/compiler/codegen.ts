import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import type { Skeleton, SkeletonState, GuardedTransition } from "./schema.js";
import { compileGuardExpr, parseGuard } from "./expr.js";
import { stateRoleMap, computeRoles, visibleProducers } from "./analysis/graph.js";
import { entryFunctions } from "./lib-fns.js";

/** Producers visible to a node, split by how the runtime exposes them (single dir vs per-branch list). */
type Visible = { single: string[]; list: string[] };
import { ensureESMPackage, reconcile, loadSkeletons, commandAgentsDir } from "./project-fs.js";
import { bundleAt } from "../layout.js";

/** Compile every skeleton in `reharness/skeletons/`, then reconcile orphan files. A per-command codegen failure
 *  is collected and re-thrown loudly at the end — never swallowed (swallowing it would make `reconcile` see the
 *  command as deleted and wipe its hand-filled artifacts). Reconcile keys orphan-deletion off the skeleton FILES on
 *  disk, so a failed (or present-but-unparseable) command keeps its artifacts; only a DELETED skeleton is pruned. */
export function generateAllFromSkeletons(reharnessDir: string): void {
  const failures: string[] = [];
  for (const sk of loadSkeletons(bundleAt(reharnessDir).skeletons)) {
    try { generateFromSkeleton(sk, reharnessDir); }
    catch (err: any) { failures.push(`${sk.id}: ${err.message}`); }
  }
  reconcile(reharnessDir);
  if (failures.length) throw new Error(`codegen failed for ${failures.length} command(s) — ${failures.join("; ")}`);
}

/** Deterministic: skeleton.xml → commands/<id>.ts + lib/<id>-states.ts + agents/<name>.md stubs. */
export function generateFromSkeleton(sk: Skeleton, reharnessDir: string): void {
  const L = bundleAt(reharnessDir);
  const commandPath = resolve(L.commands, `${sk.id}.ts`);
  const libPath = resolve(L.lib, `${sk.id}-states.ts`);
  const agentsDir = commandAgentsDir(reharnessDir, sk.id); // this command's private agent namespace

  // the bundle is the deliverable AND the package root (self-contained ⇒ liftable: `mv reharness/` keeps it runnable)
  ensureESMPackage(reharnessDir, sk.id);
  mkdirSync(dirname(commandPath), { recursive: true });
  mkdirSync(dirname(libPath), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const codeStates = Object.keys(sk.states).filter(n => sk.states[n].type === "code");
  const agentStates = Object.keys(sk.states).filter(n => {
    const t = sk.states[n].type;
    return t === "agent" || t === "interactive";
  });

  writeFileSync(commandPath, emitCommand(sk, codeStates));

  if (!existsSync(libPath)) {
    writeFileSync(libPath, emitLib(sk, codeStates));
  } else {
    let existing = readFileSync(libPath, "utf-8");
    const present = new Set(entryFunctions(existing).map(f => f.name)); // AST, not substring (no comment/string hits)
    // (1) Update return-type annotation of existing entry functions whose declared events changed.
    for (const n of codeStates) {
      if (!present.has(n)) continue;
      const events = Object.keys(sk.states[n].on || {});
      existing = updateSignature(existing, n, events);
    }
    // (2) Append stubs for new code states that don't have an entry function yet.
    const newStubs = codeStates
      .filter(n => !present.has(n))
      .map(n => stubFn(n, sk.states[n], visibleProducers(sk, n, computeRoles(sk))))
      .join("\n");
    const updated = newStubs ? existing + "\n" + newStubs : existing;
    writeFileSync(libPath, updated);
  }

  for (const name of agentStates) {
    const dir = resolve(agentsDir, name);
    const p = resolve(dir, "SYSTEM.md");
    if (!existsSync(p)) { mkdirSync(dir, { recursive: true }); writeFileSync(p, `<!-- TODO: prompt for ${name} -->\n`); }
  }

  emitCompiled(sk, reharnessDir);
}

/** Write `reharness/.cache/scratch/_compiled.md` — the single-file pipeline view for polish/redesign. `onlyId` scopes
 *  it to the command being compiled (multi-command: emitCompiled overwrites one file, so without a scope the
 *  last-by-readdir skeleton would win and polish would review the wrong command). */
export function emitCompiledFromSkeletonsDir(reharnessDir: string, onlyId?: string): void {
  for (const sk of loadSkeletons(bundleAt(reharnessDir).skeletons)) {
    if (onlyId && sk.id !== onlyId) continue;
    try { emitCompiled(sk, reharnessDir); } catch { /* skip invalid */ }
  }
}

/** Single-file consolidated view of the entire pipeline (skeleton + lib + agents).
 *  The skeleton XML embeds the topology + per-node contracts, so it is the single source of truth.
 *  Used by the `polish`/`redesign` agents so they read one file instead of 17+. */
function emitCompiled(sk: Skeleton, reharnessDir: string): void {
  const L = bundleAt(reharnessDir);
  const genDir = L.scratch;
  // _compiled.md is requested explicitly (polish/redesign/replan), so MATERIALIZE the scratch dir — don't skip when
  // it's absent (it's gitignored, so a fresh-cloned bundle running `evolve` before `compile` has no `.cache/`).
  mkdirSync(genDir, { recursive: true });
  const compiledPath = resolve(genDir, "_compiled.md");
  const skeletonPath = resolve(L.skeletons, `${sk.id}.xml`);
  const libPath = resolve(L.lib, `${sk.id}-states.ts`);
  const agentsDir = commandAgentsDir(reharnessDir, sk.id);

  const parts: string[] = [];
  parts.push(`# Compiled Pipeline: ${sk.id}\n`);
  parts.push(`> Auto-generated by codegen. Single-file view of the entire pipeline for the polish/redesign agent — read this file instead of opening skeleton + lib + every agent prompt separately. The skeleton XML embeds the topology and per-node contracts.\n`);

  if (existsSync(skeletonPath)) {
    parts.push(`## Skeleton XML (topology + contracts)\n`);
    parts.push("```xml\n" + readFileSync(skeletonPath, "utf-8").trimEnd() + "\n```\n");
  }

  parts.push(`## Agent Prompts\n`);
  for (const [name, state] of Object.entries(sk.states)) {
    if (state.type !== "agent" && state.type !== "interactive") continue;
    const p = resolve(agentsDir, name, "SYSTEM.md");
    if (!existsSync(p)) continue;
    parts.push(`### \`${name}\` (${state.type})\n`);
    parts.push("```markdown\n" + readFileSync(p, "utf-8").trimEnd() + "\n```\n");
  }

  if (existsSync(libPath)) {
    parts.push(`## Code States (lib/${sk.id}-states.ts)\n`);
    parts.push("```typescript\n" + readFileSync(libPath, "utf-8").trimEnd() + "\n```\n");
  }

  writeFileSync(compiledPath, parts.join("\n"));
}

export function emitCommand(sk: Skeleton, codeStates: string[]): string {
  const importsLib = codeStates.length
    ? `\nimport { ${codeStates.map(s => `${s}Entry`).join(", ")} } from '../lib/${sk.id}-states.js';`
    : "";

  const calledSkeletons = Array.from(new Set(
    Object.values(sk.states)
      .filter((s): s is SkeletonState & { callSkeleton: string } => s.type === "call" && !!s.callSkeleton)
      .map(s => s.callSkeleton),
  ));
  const importsCalls = calledSkeletons
    .map(id => `import subCmd_${sanitizeId(id)} from './${id}.js';`)
    .join("\n");

  const roles = stateRoleMap(sk);
  // Data inputs are DERIVED from the graph, not declared: each node sees its ancestor producers (single dir,
  // or one dir per branch for parallel-branch producers). The runtime resolves these and injects them.
  const roleMaps = computeRoles(sk);
  const stateBlocks = Object.entries(sk.states)
    .map(([n, s]) => emitState(n, s, roles.get(n), visibleProducers(sk, n, roleMaps)))
    .join("\n");
  return `import { defineCommand, definePipeline } from 'reharness';
import { resolve } from 'path';${importsLib}${importsCalls ? "\n" + importsCalls : ""}

export default defineCommand({
  description: ${JSON.stringify(sk.description)},
  usage: ${JSON.stringify(sk.usage || '<args...>')},

${emitRun(sk, stateBlocks)}
});
`;
}

/** Generate the command's `run()`. The CLI→config wiring is DERIVED from the declared `<inputs>` (the external
 *  interface), so config carries exactly the fields the pipeline reads — correct by construction. With no
 *  `<inputs>`, only `config.{target,input}` are provided (the generator convention: input → slug → target dir). */
function emitRun(sk: Skeleton, stateBlocks: string): string {
  const slugExpr = `input.replace(/[^a-zA-Z0-9\\u0400-\\u04FF]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || ${JSON.stringify(sk.id)}`;
  const pipeline = `    return definePipeline({
      config,
      agents: resolve(ctx.agents, ${JSON.stringify(sk.id)}),
      cwd: target,
      logsDir: resolve(target, 'logs'), // a run's record lives with its output (the per-input target dir), where evolve discovers executions
      initial: ${JSON.stringify(sk.initial)},
      states: {
${stateBlocks}
      },
    });`;

  if (!sk.inputs?.length) {
    return `  run: (args, ctx) => {
    const input = args.join(' ');
    const slug = ${slugExpr};
    const target = resolve(ctx.cwd, slug);
    const config = { target, input, __argv: args };
${pipeline}
  },`;
  }

  // An env-rooted DEFAULT (e.g. default="~/dotfiles") expands at the COMMAND boundary — homedir resolution belongs
  // here, not in a code state (which is linted). User-passed values are already shell-expanded, so only defaults need it.
  const envDefault = (d: typeof sk.inputs[number]) =>
    (!d.type || d.type === "string") && typeof d.default === "string" && /[~$]/.test(d.default);
  const needsExpand = sk.inputs.some(envDefault);

  let pos = 0;
  const assigns = sk.inputs.map(d => {
    const src = d.positional
      ? `positional[${pos++}]`
      : `flags[${JSON.stringify((d.flag ?? `--${d.name.replace(/_/g, "-")}`).replace(/^--/, ""))}]`;
    const coerce = (e: string) => d.type === "list" ? `String(${e}).split(',').map(s => s.trim()).filter(Boolean)`
      : d.type === "number" ? `Number(${e})`
      : d.type === "bool" ? `(${e} === true || ${e} === 'true')`
      : `String(${e})`;
    const dfltSrc = envDefault(d) ? `expandHome(${JSON.stringify(d.default)})` : JSON.stringify(d.default);
    const dflt = d.default !== undefined ? coerce(dfltSrc)
      : d.type === "list" ? "[]" : d.type === "bool" ? "false" : "undefined";
    const guard = d.required ? `if (${src} === undefined) return null; ` : "";
    return `    ${guard}config[${JSON.stringify(d.name)}] = ${src} === undefined ? ${dflt} : ${coerce(src)};`;
  });
  const expandHelper = needsExpand
    ? `    const expandHome = (s: string) => s.replace(/^~(?=$|\\/)/, process.env.HOME ?? '~').replace(/\\$\\{?(\\w+)\\}?/g, (_m, k) => process.env[k] ?? '');\n`
    : "";

  return `  run: (args, ctx) => {
    const flags: Record<string, any> = {}; const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) { const eq = a.indexOf('='); if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1); else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[a.slice(2)] = args[++i]; else flags[a.slice(2)] = true; }
      else positional.push(a);
    }
    const input = positional.join(' ');
    const slug = ${slugExpr};
    const target = resolve(ctx.cwd, slug);
    const config: Record<string, any> = { target, input, __argv: args };
${expandHelper}${assigns.join("\n")}
${pipeline}
  },`;
}

function emitState(name: string, state: SkeletonState, role?: "branch" | "join" | "step", vis: Visible = { single: [], list: [] }): string {
  const block = emitStateBody(name, state, role, vis);
  if (!state.timeout) return block;
  // Inject ` timeoutMs: N` just before the closing `},`. Match an optional preceding comma so we don't
  // duplicate it when the inner content already ends with one (multi-line templates do).
  return block.replace(/,?\s*\}\s*,\s*$/, `${timeoutField(state)} },`);
}

function emitStateBody(name: string, state: SkeletonState, role?: "branch" | "join" | "step", vis: Visible = { single: [], list: [] }): string {
  if (state.type === "final") {
    return `        ${name}: { type: 'final', status: '${state.status || "success"}' },`;
  }
  if (state.type === "approval") {
    const parts = [
      `type: 'approval'`,
      `prompt: ${JSON.stringify(state.prompt || "")}`,
      ...(state.artifacts?.length ? [`artifacts: ${JSON.stringify(state.artifacts)}`] : []),
      ...(state.autoEvent ? [`autoEvent: ${JSON.stringify(state.autoEvent)}`] : []),
      `on: ${emitTransitions(state.on || {})}`,
    ];
    return `        ${name}: { ${parts.join(", ")} },`;
  }
  if (state.type === "switch") {
    const branches = (state.branches || []).map(emitBranch).join(", ");
    return `        ${name}: { type: 'switch', branches: [${branches}] },`;
  }
  if (state.type === "parallel") {
    const overBody = compileGuardExpr(state.overExpr || "[]");
    const conc = state.concurrency !== undefined ? `, concurrency: ${state.concurrency}` : "";
    const onPart = state.on && Object.keys(state.on).length ? `, on: ${emitTransitions(state.on)}` : "";
    return `        ${name}: { type: 'parallel', over: (c) => (${overBody}), branch: '${state.parallelBranch}', join: '${state.join}'${conc}${onPart} },`;
  }
  if (state.type === "loop") {
    const stepsJson = JSON.stringify(state.loopSteps || []);
    const maxPart = state.maxIterations !== undefined ? `, max: ${state.maxIterations}` : "";
    const exitPart = state.exitExpr ? `, exit: (c) => (${compileGuardExpr(state.exitExpr)})` : "";
    const onPart = state.on && Object.keys(state.on).length ? `, on: ${emitTransitions(state.on)}` : "";
    return `        ${name}: { type: 'loop', steps: ${stepsJson}, join: '${state.join}'${maxPart}${exitPart}${onPart} },`;
  }
  if (state.type === "wait") {
    const parts: string[] = [`type: 'wait'`, `mode: ${JSON.stringify(state.waitMode)}`];
    if (state.waitDuration) parts.push(`durationMs: ${parseDurationMs(state.waitDuration)}`);
    if (state.waitTimeout) parts.push(`timeoutMs: ${parseDurationMs(state.waitTimeout)}`);
    if (state.waitPath) parts.push(`path: ${JSON.stringify(state.waitPath)}`);
    if (state.waitCommand) parts.push(`command: ${JSON.stringify(state.waitCommand)}`);
    if (state.waitPort !== undefined) parts.push(`port: ${state.waitPort}`);
    if (state.waitPollInterval) parts.push(`pollIntervalMs: ${parseDurationMs(state.waitPollInterval)}`);
    parts.push(`on: ${emitTransitions(state.on || {})}`);
    return `        ${name}: { ${parts.join(", ")} },`;
  }
  if (state.type === "call") {
    const subId = state.callSkeleton!;
    const argsBody = state.callArgsExpr ? compileGuardExpr(state.callArgsExpr) : "[]";
    const onObj = emitTransitions(state.on || {});
    return `        ${name}: {
          type: 'call',
          skeleton: ${JSON.stringify(subId)},
          argsFn: (c) => (${argsBody}),
          callFactory: (callArgs) => subCmd_${sanitizeId(subId)}.run(callArgs, ctx),
          on: ${onObj},
        },`;
  }
  if (state.type === "set") {
    const assignments = (state.dataAssignments || [])
      .map(a => `            c.data[${JSON.stringify(a.key)}] = ${compileGuardExpr(a.value)};`)
      .join("\n");
    return `        ${name}: {
          entry: async (c) => {
${assignments}
            return 'DONE';
          },
          on: ${emitTransitions(state.on || { DONE: "" })},
        },`;
  }

  const on = { ...(state.on || {}) };
  if (state.type === "code" && !on["ERROR"]) on["ERROR"] = "error";

  if (state.type === "agent") {
    const optsExpr = agentOpts(state, role, vis);
    if (role === "branch") {
      return `        ${name}: {
          entry: async (c) => {
            const task = [
              \`Execute the ${name} stage (parallel branch \${c.branchIndex}).\`,
              \`Working directory: \${c.config.target}\`,
              \`Branch input: \${JSON.stringify(c.branchInput)}\`,
            ].join('\\n');
            await c.agent('${name}', task, ${optsExpr});
          },
          on: ${emitTransitions(on)},
        },`;
    }
    if (role === "join") {
      return `        ${name}: {
          entry: async (c) => {
            const task = [
              \`Execute the ${name} stage (joining branches/iterations).\`,
              \`Working directory: \${c.config.target}\`,
              \`Input: \${c.config.input}\`,
              c.data.branches !== undefined ? \`Branches: \${JSON.stringify(c.data.branches)}\` : '',
              c.data.iterations !== undefined ? \`Iterations completed: \${c.data.iterations}\` : '',
            ].filter(Boolean).join('\\n');
            await c.agent('${name}', task, ${optsExpr});
          },
          on: ${emitTransitions(on)},
        },`;
    }
    if (role === "step") {
      return `        ${name}: {
          entry: async (c) => {
            const task = [
              \`Execute the ${name} stage (loop step, iteration \${c.data.iteration}).\`,
              \`Working directory: \${c.config.target}\`,
              \`Input: \${c.config.input}\`,
            ].join('\\n');
            await c.agent('${name}', task, ${optsExpr});
          },
          on: ${emitTransitions(on)},
        },`;
    }
    return `        ${name}: {
          entry: async (c) => { await c.agent('${name}', \`Execute the ${name} stage.\\nWorking directory: \${c.config.target}\\nInput: \${c.config.input}\`, ${optsExpr}); },
          on: ${emitTransitions(on)},
        },`;
  }

  if (state.type === "interactive") {
    const artifacts = state.artifacts || [];
    const artifactsJson = JSON.stringify(artifacts);
    const fileList = artifacts.map(a => `  - ${a}`).join("\\n");
    return `        ${name}: {
          entry: async (c) => {
            const artifacts = ${artifactsJson};
            const task = [
              \`Execute the ${name} stage (interactive).\`,
              \`Working directory: \${c.config.target}\`,
              \`Input: \${c.config.input}\`,
              '',
              'CONTRACT — you MUST follow:',
              '- Edit ONLY these files:\\n${fileList}',
              '- Do not create, rename, or delete other files.',
              '- Do not modify files outside the working directory.',
              '- When done, exit the Pi session (Ctrl+D or /quit).',
            ].join('\\n');
            await c.interactive('${name}', task, { artifacts });
          },
          on: ${emitTransitions(on)},
        },`;
  }

  // code state
  const retryIncrements = retryKeysOf(on)
    .map(({ event, key }) => `              if (event === '${event}') c.retry('${key}');`)
    .join("\n");
  return `        ${name}: {
          entry: async (c) => {
            try {
              const event = await ${name}Entry(c);
${retryIncrements ? retryIncrements + "\n" : ""}              return event;
            } catch (err: any) {
              c.emit(\`✗ ${name}: \${err.message}\`);
              return 'ERROR';
            }
          },
          on: ${emitTransitions(on)},
        },`;
}

function emitTransitions(on: Record<string, string | GuardedTransition[]>): string {
  const entries = Object.entries(on);
  if (entries.length === 1 && entries[0][0] === "DONE" && typeof entries[0][1] === "string") {
    return `'${entries[0][1]}'`;
  }
  const parts = entries.map(([event, target]) => {
    if (typeof target === "string") return `${event}: '${target}'`;
    return `${event}: [${target.map(emitBranch).join(", ")}]`;
  });
  return `{ ${parts.join(", ")} }`;
}

function emitBranch(gt: GuardedTransition): string {
  const g = parseGuard(gt.guard);
  if (g?.kind === "retries") return `{ target: '${gt.target}', guard: (c) => c.retries('${g.key}') < ${g.max} }`;
  if (g?.kind === "expr") return `{ target: '${gt.target}', guard: (c) => (${compileGuardExpr(g.expr)}) }`;
  return `{ target: '${gt.target}' }`;
}

function retryKeysOf(on: Record<string, string | GuardedTransition[]>): Array<{ event: string; key: string }> {
  const out: Array<{ event: string; key: string }> = [];
  // At most ONE retry increment per event: the entry function fires `c.retry(key)` once when the event occurs.
  // If an event has several retry-guarded branches, they share the same counter intent — emitting one c.retry
  // per branch would multiply-increment on a single occurrence. Keep the first key seen for each event.
  for (const [event, target] of Object.entries(on)) {
    if (!Array.isArray(target)) continue;
    for (const t of target) {
      const g = parseGuard(t.guard);
      if (g?.kind === "retries") { out.push({ event, key: g.key }); break; }
    }
  }
  return out;
}

function returnUnion(events: string[]): string {
  return events.length ? events.map(e => `'${e}'`).join(" | ") : "'DONE'";
}

function stubFn(name: string, state: SkeletonState, vis: Visible = { single: [], list: [] }): string {
  const events = Object.keys(state.on || {});
  const union = returnUnion(events);
  // The runtime owns all paths — never build one by hand. Write this state's own output files into c.out();
  // read a single upstream producer's files from c.dir('<stage>'); read a parallel-branch producer's per-item
  // dirs from c.dirs('<stage>'). ctx.data carries scalar values to guards.
  const hints = [
    ...vis.single.map(p => `  //   - readFileSync(join(c.dir('${p}'), '<file>'))`),
    ...vis.list.map(p => `  //   - for (const d of c.dirs('${p}')) readFileSync(join(d, '<file>'))  // one dir per branch`),
  ];
  const inputsHint = hints.length ? `  // Upstream outputs available to read:\n${hints.join("\n")}\n` : "";
  return `export async function ${name}Entry(c: any): Promise<${union}> {
  // TODO: implement ${name} — write outputs into c.out(). May be async (e.g. await fetch for network).
${inputsHint}  // Returns only events declared by the skeleton's <on>: ${union}.
  // Do not invent additional return values — let exceptions throw (codegen wraps them as ERROR).
  return '${events[0] || "DONE"}';
}
`;
}

/** Rewrite the return type annotation of `[async ]function <name>Entry(...): TYPE` to the new union. Preserves body. */
function updateSignature(source: string, name: string, events: string[]): string {
  const union = returnUnion(events);
  const re = new RegExp(
    `(export (?:async )?function ${name}Entry\\s*\\([^)]*\\)\\s*:\\s*)[^{\\n]+?(\\s*\\{)`,
    "m",
  );
  return source.replace(re, `$1Promise<${union}>$2`);
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Build the `opts` argument for an agent state's c.agent(name, task, OPTS) call.
 *  Merges dynamic model routing (modelExpr > parallel-branch input) with the visible producers — single-dir
 *  (`inputs`) and per-branch (`inputLists`) — that the runtime exposes to this agent. All DERIVED from the
 *  topology (visibleProducers), never declared, so producer and consumer can't drift. */
function agentOpts(state: SkeletonState, role: "branch" | "join" | "step" | undefined, vis: Visible): string {
  const dataEntries: string[] = [];
  if (vis.single.length) dataEntries.push(`inputs: ${JSON.stringify(vis.single)}`);
  if (vis.list.length) dataEntries.push(`inputLists: ${JSON.stringify(vis.list)}`);

  const modelSrc = state.modelExpr
    ? compileGuardExpr(state.modelExpr)
    : role === "branch"
      ? `((c.branchInput && typeof c.branchInput === 'object') ? c.branchInput.model : undefined)`
      : null;

  if (!dataEntries.length && !modelSrc) return "undefined";

  // IIFE so the dynamic model and the derived inputs merge cleanly into one opts object.
  const entries = ["...(m ? { model: m } : {})", ...dataEntries];
  return `(((m) => ({ ${entries.join(", ")} }))(${modelSrc ?? "undefined"}))`;
}

function timeoutField(state: SkeletonState): string {
  return state.timeout ? `, timeoutMs: ${parseDurationMs(state.timeout)}` : "";
}

function parseDurationMs(s: string): number {
  const m = s.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!m) throw new Error(`Invalid duration: '${s}'`);
  const n = parseInt(m[1], 10);
  return m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
}

function emitLib(sk: Skeleton, codeStates: string[]): string {
  const roleMaps = computeRoles(sk);
  const fns = codeStates.map(n => stubFn(n, sk.states[n], visibleProducers(sk, n, roleMaps))).join("\n");
  return `// Code-state entry functions for ${sk.id}. Each returns an event string.\n\n${fns}`;
}

