import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { parseSkeletonXML } from "./xml.js";

/** Check that a generated `.reharness/` directory is structurally valid and the TS imports + FSM graph load. */
export function verifyGenerated(targetDir: string): string[] {
  const errors: string[] = [];
  const root = resolve(targetDir, ".reharness");
  const commandsDir = resolve(root, "commands");
  const agentsDir = resolve(root, "agents");
  const libDir = resolve(root, "lib");
  const skeletonsDir = resolve(root, "skeletons");

  if (!existsSync(commandsDir)) return ["## Missing\n`.reharness/commands/` does not exist"];

  const commandFiles = readdirSync(commandsDir).filter(f => f.endsWith(".ts"));
  if (commandFiles.length === 0) return ["## No commands\nNo `.ts` files in `.reharness/commands/`"];

  const agentMd = existsSync(agentsDir)
    ? new Set(readdirSync(agentsDir).filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")))
    : new Set<string>();

  // 1. Every skeleton's agent/code states must have filled prompts / implementations.
  for (const file of existsSync(skeletonsDir) ? readdirSync(skeletonsDir).filter(f => f.endsWith(".xml")) : []) {
    let sk;
    try { sk = parseSkeletonXML(readFileSync(resolve(skeletonsDir, file), "utf-8")); }
    catch (e: any) { errors.push(`## Invalid skeleton\n\`${file}\`: ${e.message}`); continue; }

    for (const [name, state] of Object.entries(sk.states)) {
      if (state.type !== "agent" && state.type !== "interactive") continue;
      if (!agentMd.has(name)) {
        errors.push(`## Missing agent prompt\n[${sk.id}] state \`${name}\` requires \`agents/${name}.md\``);
      } else if (readFileSync(resolve(agentsDir, `${name}.md`), "utf-8").includes("<!-- TODO")) {
        errors.push(`## Unfilled prompt\n[${sk.id}] \`agents/${name}.md\` is still a stub`);
      }
    }
    const libPath = resolve(libDir, `${sk.id}-states.ts`);
    if (existsSync(libPath)) {
      const lib = readFileSync(libPath, "utf-8");
      const todos = (lib.match(/\/\/\s*TODO/g) || []).length;
      if (todos) errors.push(`## Unfilled code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` has ${todos} TODO(s)`);

      // Code states must be deterministic — they must NOT invoke agents. An embedded `c.agent('X')`
      // has no prompt file (codegen only creates prompts for declared agent states) and throws at runtime.
      const embedded = new Set<string>();
      for (const m of lib.matchAll(/\b(?:c|ctx)\.agent\(\s*['"]([^'"]+)['"]/g)) embedded.add(m[1]);
      if (embedded.size) {
        errors.push(`## Embedded agent call in code state\n[${sk.id}] \`lib/${sk.id}-states.ts\` calls c.agent(${[...embedded].map(n => `'${n}'`).join(", ")}) from a code state. Code states are deterministic and must not invoke agents — promote each LLM call to its own \`agent\` state (or a \`parallel\`/\`loop\` over an agent state).`);
      }
    }
  }

  // 2. TypeScript compile.
  if (existsSync(resolve(targetDir, "tsconfig.json"))) {
    try {
      execFileSync("npx", ["tsc", "--noEmit"], { cwd: targetDir, encoding: "utf-8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      errors.push(`## TypeScript errors\n\`\`\`\n${(err.stdout || err.stderr || err.message).slice(0, 2000)}\n\`\`\``);
    }
  }

  // 3. Each command imports cleanly. A null return from run() is valid (command may require specific args).
  for (const file of commandFiles) {
    const path = resolve(commandsDir, file);
    const script = `import cmd from '${path}';
if (!cmd?.run) { console.error('no run()'); process.exit(1); }
cmd.run(['probe', 'arg2', 'arg3'], { root: '${targetDir}', agents: '${agentsDir}', cwd: '${targetDir}' });`;
    try {
      execFileSync("node", ["--import", "tsx/esm", "-e", script], { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: any) {
      errors.push(`## FSM validation: ${file}\n\`\`\`\n${(err.stdout || err.stderr || err.message).slice(0, 2000)}\n\`\`\``);
    }
  }

  return errors;
}
