import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import type { Skeleton, SkeletonState, GuardedTransition } from "./schema.js";
import { parseSkeletonXML } from "./xml.js";
import { compileGuardExpr } from "./expr.js";

/** Compile every skeleton in `.reharness/skeletons/`, then reconcile orphan files. */
export function generateAllFromSkeletons(reharnessDir: string): void {
  const skeletonsDir = resolve(reharnessDir, "skeletons");
  if (!existsSync(skeletonsDir)) return;

  const skeletons: Skeleton[] = [];
  for (const file of readdirSync(skeletonsDir).filter(f => f.endsWith(".xml"))) {
    try {
      const sk = parseSkeletonXML(readFileSync(resolve(skeletonsDir, file), "utf-8"));
      generateFromSkeleton(sk, reharnessDir);
      skeletons.push(sk);
    } catch { /* invalid XML — skip */ }
  }
  reconcile(reharnessDir, skeletons);
}

/** Deterministic: skeleton.xml → commands/<id>.ts + lib/<id>-states.ts + agents/<name>.md stubs. */
export function generateFromSkeleton(sk: Skeleton, reharnessDir: string): void {
  const commandPath = resolve(reharnessDir, "commands", `${sk.id}.ts`);
  const libPath = resolve(reharnessDir, "lib", `${sk.id}-states.ts`);
  const agentsDir = resolve(reharnessDir, "agents");

  ensureESMPackage(resolve(reharnessDir, ".."), sk.id);
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
    const existing = readFileSync(libPath, "utf-8");
    const stubs = codeStates
      .filter(n => !existing.includes(`function ${n}Entry`))
      .map(n => stubFn(n, Object.keys(sk.states[n].on || {})))
      .join("\n");
    if (stubs) appendFileSync(libPath, "\n" + stubs);
  }

  for (const name of agentStates) {
    const p = resolve(agentsDir, `${name}.md`);
    if (!existsSync(p)) writeFileSync(p, `<!-- TODO: prompt for ${name} -->\n`);
  }
}

function ensureESMPackage(projectRoot: string, fallbackName: string): void {
  const pkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: fallbackName, private: true, type: "module" }, null, 2) + "\n");
    return;
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!pkg.type) {
      pkg.type = "module";
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  } catch { /* corrupt — leave alone */ }
}

function emitCommand(sk: Skeleton, codeStates: string[]): string {
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

  const roles = new Map<string, "branch" | "join" | "step">();
  for (const s of Object.values(sk.states)) {
    if (s.type === "parallel") {
      if (s.parallelBranch) roles.set(s.parallelBranch, "branch");
      if (s.parallelJoin) roles.set(s.parallelJoin, "join");
    }
    if (s.type === "loop") {
      for (const step of s.loopSteps || []) roles.set(step, "step");
      if (s.parallelJoin) roles.set(s.parallelJoin, "join");
    }
  }
  const stateBlocks = Object.entries(sk.states).map(([n, s]) => emitState(n, s, roles.get(n))).join("\n");
  return `import { defineCommand, definePipeline } from 'reharness';
import { resolve } from 'path';${importsLib}${importsCalls ? "\n" + importsCalls : ""}

export default defineCommand({
  description: ${JSON.stringify(sk.description)},
  usage: ${JSON.stringify(sk.usage || '<args...>')},

  run: (args, ctx) => {
    const input = args.join(' ');
    const slug = input.replace(/[^a-zA-Z0-9\\u0400-\\u04FF]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || '${sk.id}';
    const target = resolve(ctx.cwd, slug);

    return definePipeline({
      config: { target, input },
      agents: ctx.agents,
      cwd: target,
      logsDir: resolve(target, 'logs'),
      initial: ${JSON.stringify(sk.initial)},
      states: {
${stateBlocks}
      },
    });
  },
});
`;
}

function emitState(name: string, state: SkeletonState, role?: "branch" | "join" | "step"): string {
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
    return `        ${name}: { type: 'parallel', over: (c) => (${overBody}), branch: '${state.parallelBranch}', join: '${state.parallelJoin}'${conc} },`;
  }
  if (state.type === "loop") {
    const stepsJson = JSON.stringify(state.loopSteps || []);
    const maxPart = state.maxIterations !== undefined ? `, max: ${state.maxIterations}` : "";
    const exitPart = state.exitExpr ? `, exit: (c) => (${compileGuardExpr(state.exitExpr)})` : "";
    return `        ${name}: { type: 'loop', steps: ${stepsJson}, join: '${state.parallelJoin}'${maxPart}${exitPart} },`;
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
    if (role === "branch") {
      return `        ${name}: {
          entry: async (c) => {
            const task = [
              \`Execute the ${name} stage (parallel branch \${c.branchIndex}).\`,
              \`Working directory: \${c.config.target}\`,
              \`Branch directory: \${c.branchDir}\`,
              \`Branch input: \${JSON.stringify(c.branchInput)}\`,
            ].join('\\n');
            const opts = (c.branchInput && typeof c.branchInput === 'object' && c.branchInput.model)
              ? { model: c.branchInput.model } : undefined;
            await c.agent('${name}', task, opts);
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
            await c.agent('${name}', task);
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
            await c.agent('${name}', task);
          },
          on: ${emitTransitions(on)},
        },`;
    }
    return `        ${name}: {
          entry: async (c) => { await c.agent('${name}', \`Execute the ${name} stage.\\nWorking directory: \${c.config.target}\\nInput: \${c.config.input}\`); },
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
              const event = ${name}Entry(c);
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
  if (!gt.guard) return `{ target: '${gt.target}' }`;
  const retry = gt.guard.match(/^retries:(\w+)<(\d+)$/);
  if (retry) return `{ target: '${gt.target}', guard: (c) => c.retries('${retry[1]}') < ${retry[2]} }`;
  if (gt.guard.startsWith("expr:")) {
    const body = compileGuardExpr(gt.guard.slice(5));
    return `{ target: '${gt.target}', guard: (c) => (${body}) }`;
  }
  return `{ target: '${gt.target}' }`;
}

function retryKeysOf(on: Record<string, string | GuardedTransition[]>): Array<{ event: string; key: string }> {
  const out: Array<{ event: string; key: string }> = [];
  for (const [event, target] of Object.entries(on)) {
    if (!Array.isArray(target)) continue;
    for (const gt of target) {
      const m = gt.guard?.match(/^retries:(\w+)<(\d+)$/);
      if (m) out.push({ event, key: m[1] });
    }
  }
  return out;
}

function stubFn(name: string, events: string[]): string {
  return `export function ${name}Entry(c: any): string {
  // TODO: implement ${name}
  // Returns: ${events.map(e => `'${e}'`).join(", ") || "'DONE'"}
  return '${events[0] || "DONE"}';
}
`;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function emitLib(sk: Skeleton, codeStates: string[]): string {
  const fns = codeStates.map(n => stubFn(n, Object.keys(sk.states[n].on || {}))).join("\n");
  return `// Code-state entry functions for ${sk.id}. Each returns an event string.\n\n${fns}`;
}

/** Remove agent .md files and lib *Entry functions whose state was removed from the skeletons. */
function reconcile(reharnessDir: string, skeletons: Skeleton[]): void {
  const allAgents = new Set<string>();
  const codeStatesById = new Map<string, Set<string>>();
  for (const sk of skeletons) {
    const code = new Set<string>();
    for (const [name, s] of Object.entries(sk.states)) {
      if (s.type === "agent" || s.type === "interactive") allAgents.add(name);
      if (s.type === "code") code.add(name);
    }
    codeStatesById.set(sk.id, code);
  }

  const agentsDir = resolve(reharnessDir, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
      if (!allAgents.has(file.replace(/\.md$/, ""))) unlinkSync(resolve(agentsDir, file));
    }
  }

  const libDir = resolve(reharnessDir, "lib");
  if (!existsSync(libDir)) return;
  for (const [id, code] of codeStatesById) {
    const path = resolve(libDir, `${id}-states.ts`);
    if (!existsSync(path)) continue;
    const cleaned = pruneEntryFns(readFileSync(path, "utf-8"), code);
    if (cleaned !== null) writeFileSync(path, cleaned);
  }
}

/** Drop top-level `export function <name>Entry` blocks whose <name> isn't in the live set. */
function pruneEntryFns(source: string, liveStates: Set<string>): string | null {
  const lines = source.split("\n");
  const out: string[] = [];
  let dropping = false;
  let changed = false;

  for (const line of lines) {
    const m = line.match(/^export function (\w+)Entry\b/);
    if (m) {
      dropping = !liveStates.has(m[1]);
      if (dropping) { changed = true; continue; }
    } else if (dropping && /^export function \w+/.test(line)) {
      // next top-level function — stop dropping, evaluate this one
      const m2 = line.match(/^export function (\w+)Entry\b/);
      dropping = !!m2 && !liveStates.has(m2[1]);
      if (dropping) { changed = true; continue; }
    }
    if (!dropping) out.push(line);
  }
  return changed ? out.join("\n") : null;
}
