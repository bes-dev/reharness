import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import type { SkeletonJSON, SkeletonState, GuardedTransition } from "./skeleton-schema.js";

/**
 * Generate commands from ALL skeletons in skeletons/ directory.
 * Each skeleton.json → one command .ts file.
 * Then reconcile: remove orphaned agents and dead lib functions.
 */
export function generateAllFromSkeletons(reharnessDir: string): void {
  const skeletonsDir = resolve(reharnessDir, "skeletons");
  if (!existsSync(skeletonsDir)) return;

  const skeletons: SkeletonJSON[] = [];
  for (const file of readdirSync(skeletonsDir).filter(f => f.endsWith(".json"))) {
    try {
      const skeleton: SkeletonJSON = JSON.parse(readFileSync(resolve(skeletonsDir, file), "utf-8"));
      generateFromSkeleton(skeleton, reharnessDir);
      skeletons.push(skeleton);
    } catch { /* invalid JSON — skip */ }
  }

  reconcile(reharnessDir, skeletons);
}

/**
 * Deterministic: skeleton.json → .reharness/commands/<id>.ts + .reharness/lib/<id>-states.ts
 * No LLM involved. Pure JSON → TypeScript transformation.
 */
export function generateFromSkeleton(skeleton: SkeletonJSON, reharnessDir: string): void {
  const projectRoot = resolve(reharnessDir, "..");
  const commandPath = resolve(reharnessDir, "commands", `${skeleton.id}.ts`);
  const libPath = resolve(reharnessDir, "lib", `${skeleton.id}-states.ts`);
  const agentsDir = resolve(reharnessDir, "agents");

  // Ensure project has package.json with ESM support (required for generated .ts imports)
  const pkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({ name: skeleton.id, private: true, type: "module" }, null, 2) + "\n");
  } else {
    // Ensure existing package.json has "type": "module"
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (!pkg.type) {
        pkg.type = "module";
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      }
    } catch { /* corrupt package.json — leave it */ }
  }

  mkdirSync(dirname(commandPath), { recursive: true });
  mkdirSync(dirname(libPath), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const codeStates = Object.entries(skeleton.states)
    .filter(([, s]) => s.type === "code")
    .map(([name]) => name);

  const agentStates = Object.entries(skeleton.states)
    .filter(([, s]) => s.type === "agent")
    .map(([name]) => name);

  writeFileSync(commandPath, generateCommandFile(skeleton, codeStates));

  // Lib: only create if new, or append stubs for new code states
  if (!existsSync(libPath)) {
    writeFileSync(libPath, generateLibFile(skeleton, codeStates));
  } else {
    // Append stubs only for code states that don't have an entry function yet
    const existing = readFileSync(libPath, "utf-8");
    const newStubs: string[] = [];
    for (const name of codeStates) {
      if (!existing.includes(`function ${name}Entry`)) {
        const state = skeleton.states[name];
        const events = Object.keys(state.on || {});
        newStubs.push(`\nexport function ${name}Entry(c: any): string {`);
        newStubs.push(`  // TODO: implement ${name} logic`);
        newStubs.push(`  // Possible return values: ${events.map(e => `'${e}'`).join(", ")}`);
        newStubs.push(`  return '${events[0] || "DONE"}';`);
        newStubs.push(`}\n`);
      }
    }
    if (newStubs.length > 0) {
      appendFileSync(libPath, newStubs.join("\n"));
    }
  }

  // Generate stub .md files only for NEW agent states (don't overwrite existing prompts)
  for (const name of agentStates) {
    const promptPath = resolve(agentsDir, `${name}.md`);
    if (!existsSync(promptPath)) {
      writeFileSync(promptPath, `<!-- TODO: write prompt for ${name} agent -->\n`);
    }
  }
}

function generateCommandFile(skeleton: SkeletonJSON, codeStates: string[]): string {
  const lines: string[] = [];

  lines.push(`import { defineCommand, definePipeline } from 'reharness';`);
  lines.push(`import { resolve } from 'path';`);
  if (codeStates.length > 0) {
    const imports = codeStates.map(s => `${s}Entry`).join(", ");
    lines.push(`import { ${imports} } from '../lib/${skeleton.id}-states.js';`);
  }
  lines.push(``);
  lines.push(`export default defineCommand({`);
  lines.push(`  description: ${JSON.stringify(skeleton.description)},`);
  lines.push(`  usage: ${JSON.stringify(skeleton.usage || '<args...>')},`);
  lines.push(``);
  lines.push(`  run: (args, ctx) => {`);
  lines.push(`    const input = args.join(' ');`);
  lines.push(`    const slug = input.replace(/[^a-zA-Z0-9\\u0400-\\u04FF]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || '${skeleton.id}';`);
  lines.push(`    const target = resolve(ctx.cwd, slug);`);
  lines.push(``);
  lines.push(`    return definePipeline({`);
  lines.push(`      config: { target, input },`);
  lines.push(`      agents: ctx.agents,`);
  lines.push(`      cwd: target,`);
  lines.push(`      logsDir: resolve(target, 'logs'),`);
  lines.push(`      initial: ${JSON.stringify(skeleton.initial)},`);
  lines.push(``);
  lines.push(`      states: {`);

  for (const [name, state] of Object.entries(skeleton.states)) {
    lines.push(generateState(name, state));
  }

  lines.push(`      },`);
  lines.push(`    });`);
  lines.push(`  },`);
  lines.push(`});`);
  lines.push(``);

  return lines.join("\n");
}

function generateState(name: string, state: SkeletonState): string {
  if (state.type === "final") {
    return `        ${name}: { type: 'final', status: '${state.status || "success"}' },`;
  }

  // Find retry keys from guarded transitions (retries:key<N)
  const retryKeys = findRetryKeys(state.on || {});

  const lines: string[] = [];
  lines.push(`        ${name}: {`);

  if (state.type === "agent") {
    lines.push(`          entry: async (c) => {`);
    lines.push(`            await c.agent('${name}', [`);
    lines.push(`              \`Execute the ${name} stage.\`,`);
    lines.push(`              \`Working directory: \${c.config.target}\`,`);
    lines.push(`              \`Input: \${c.config.input}\`,`);
    lines.push(`            ].join('\\n'));`);
    lines.push(`          },`);
  } else {
    // Code state: wrap in try/catch, auto-increment retry counters for guarded events
    lines.push(`          entry: async (c) => {`);
    lines.push(`            try {`);
    lines.push(`              const event = ${name}Entry(c);`);
    // Increment retry counter for events that have guarded transitions
    for (const { event, key } of retryKeys) {
      lines.push(`              if (event === '${event}') c.retry('${key}');`);
    }
    lines.push(`              return event;`);
    lines.push(`            } catch (err: any) {`);
    lines.push(`              c.emit(\`✗ ${name}: \${err.message}\`);`);
    lines.push(`              return 'ERROR';`);
    lines.push(`            }`);
    lines.push(`          },`);
  }

  // Ensure ERROR transition exists for code states
  const on = { ...(state.on || {}) };
  if (state.type === "code" && !on["ERROR"]) {
    on["ERROR"] = "error";
  }

  lines.push(`          on: ${generateTransitions(on)},`);
  lines.push(`        },`);

  return lines.join("\n");
}

/** Extract retry keys from guarded transitions: retries:key<N → {event, key} */
function findRetryKeys(on: Record<string, string | GuardedTransition[]>): Array<{event: string, key: string}> {
  const keys: Array<{event: string, key: string}> = [];
  for (const [event, target] of Object.entries(on)) {
    if (Array.isArray(target)) {
      for (const gt of target) {
        if (gt.guard) {
          const match = gt.guard.match(/^retries:(\w+)<(\d+)$/);
          if (match) keys.push({ event, key: match[1] });
        }
      }
    }
  }
  return keys;
}

function generateTransitions(on: Record<string, string | GuardedTransition[]>): string {
  const entries = Object.entries(on);

  if (entries.length === 1 && typeof entries[0][1] === "string" && entries[0][0] === "DONE") {
    return `'${entries[0][1]}'`;
  }

  const parts: string[] = [];
  for (const [event, target] of entries) {
    if (typeof target === "string") {
      parts.push(`${event}: '${target}'`);
    } else {
      const guards = target.map(gt => {
        if (gt.guard) {
          const match = gt.guard.match(/^retries:(\w+)<(\d+)$/);
          if (match) {
            return `{ target: '${gt.target}', guard: (c) => c.retries('${match[1]}') < ${match[2]} }`;
          }
        }
        return `{ target: '${gt.target}' }`;
      });
      parts.push(`${event}: [\n              ${guards.join(",\n              ")},\n            ]`);
    }
  }

  return `{\n            ${parts.join(",\n            ")},\n          }`;
}

function generateLibFile(skeleton: SkeletonJSON, codeStates: string[]): string {
  const lines: string[] = [];

  lines.push(`// Code state entry functions for ${skeleton.id}`);
  lines.push(`// Fill in the deterministic logic for each code state.`);
  lines.push(`// Each function returns an event string that determines the next transition.`);
  lines.push(``);

  for (const name of codeStates) {
    const state = skeleton.states[name];
    const events = Object.keys(state.on || {});

    lines.push(`export function ${name}Entry(c: any): string {`);
    lines.push(`  // TODO: implement ${name} logic`);
    lines.push(`  // Possible return values: ${events.map(e => `'${e}'`).join(", ")}`);
    lines.push(`  return '${events[0] || "DONE"}';`);
    lines.push(`}`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Reconcile filesystem against skeletons: remove orphaned agents and dead lib functions.
 */
function reconcile(reharnessDir: string, skeletons: SkeletonJSON[]): void {
  const agentsDir = resolve(reharnessDir, "agents");
  const libDir = resolve(reharnessDir, "lib");

  // Collect all agent state names and per-skeleton code state names
  const allAgentStates = new Set<string>();
  const codeStatesBySkeletonId = new Map<string, Set<string>>();

  for (const sk of skeletons) {
    const codeStates = new Set<string>();
    for (const [name, state] of Object.entries(sk.states)) {
      if (state.type === "agent") allAgentStates.add(name);
      if (state.type === "code") codeStates.add(name);
    }
    codeStatesBySkeletonId.set(sk.id, codeStates);
  }

  // Remove orphaned agent .md files
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
      const name = file.replace(".md", "");
      if (!allAgentStates.has(name)) {
        unlinkSync(resolve(agentsDir, file));
      }
    }
  }

  // Remove dead functions from lib files
  if (existsSync(libDir)) {
    for (const [skeletonId, codeStates] of codeStatesBySkeletonId) {
      const libPath = resolve(libDir, `${skeletonId}-states.ts`);
      if (!existsSync(libPath)) continue;
      const cleaned = removeDeadFunctions(readFileSync(libPath, "utf-8"), codeStates);
      if (cleaned !== null) writeFileSync(libPath, cleaned);
    }
  }
}

/**
 * Parse a lib file and remove exported functions that are:
 * 1. Not a code state entry (name not in liveStates)
 * 2. Not called by any other function in the file
 * Returns cleaned content, or null if nothing changed.
 */
function removeDeadFunctions(source: string, liveStates: Set<string>): string | null {
  const funcPattern = /^export function (\w+Entry)\b/;
  const lines = source.split("\n");

  const preambleLines: string[] = [];
  const functions: Array<{ name: string; stateName: string; lines: string[] }> = [];
  let current: { name: string; stateName: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(funcPattern);
    if (match) {
      if (current) functions.push(current);
      const funcName = match[1];
      const stateName = funcName.replace(/Entry$/, "");
      current = { name: funcName, stateName, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) functions.push(current);

  // A function is live if it's a code state entry OR called by another function
  const liveNames = new Set(functions.filter(f => liveStates.has(f.stateName)).map(f => f.name));

  // Iteratively mark functions as live if referenced by other live functions
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of functions) {
      if (liveNames.has(f.name)) continue;
      const body = f.lines.join("\n");
      for (const liveName of liveNames) {
        if (body.includes(liveName)) { // referenced by a live function? nope, check the other way
          break;
        }
      }
      // Check if any live function references this one
      for (const live of functions) {
        if (!liveNames.has(live.name)) continue;
        if (live.lines.join("\n").includes(f.name)) {
          liveNames.add(f.name);
          changed = true;
          break;
        }
      }
    }
  }

  const liveFunctions = functions.filter(f => liveNames.has(f.name));
  if (liveFunctions.length === functions.length) return null;

  return [
    ...preambleLines,
    ...liveFunctions.flatMap(f => f.lines),
  ].join("\n");
}
