import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import type { SkeletonJSON } from "./skeleton-schema.js";

export function verifyGenerated(targetDir: string): string[] {
  const errors: string[] = [];

  const commandsDir = resolve(targetDir, ".reharness", "commands");
  const agentsDir = resolve(targetDir, ".reharness", "agents");
  const libDir = resolve(targetDir, ".reharness", "lib");
  const skeletonFile = resolve(targetDir, ".reharness", "generate", "skeleton.json");

  // 1. Check .reharness/commands/ has at least one .ts file
  if (!existsSync(commandsDir)) {
    errors.push("## Missing directory\n`.reharness/commands/` does not exist");
    return errors;
  }
  const commandFiles = readdirSync(commandsDir).filter(f => f.endsWith(".ts"));
  if (commandFiles.length === 0) {
    errors.push("## No commands\nNo `.ts` files found in `.reharness/commands/`");
    return errors;
  }

  // 2. Check agent references — scan command files for ctx.agent('name', ...) calls
  if (existsSync(agentsDir)) {
    const agentFiles = new Set(readdirSync(agentsDir).filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")));
    for (const cmdFile of commandFiles) {
      const content = readFileSync(resolve(commandsDir, cmdFile), "utf-8");
      const refs = content.matchAll(/\.agent\s*\(\s*['"]([^'"]+)['"]/g);
      for (const match of refs) {
        if (!agentFiles.has(match[1])) {
          errors.push(`## Missing agent prompt\n\`${cmdFile}\` references agent \`${match[1]}\` but \`.reharness/agents/${match[1]}.md\` does not exist`);
        }
      }
    }
  } else {
    errors.push("## Missing directory\n`.reharness/agents/` does not exist");
  }

  // 3. Skeleton completeness — if skeleton.json exists, verify all promises are fulfilled
  if (existsSync(skeletonFile)) {
    try {
      const skeleton: SkeletonJSON = JSON.parse(readFileSync(skeletonFile, "utf-8"));
      const agentMdFiles = existsSync(agentsDir)
        ? new Set(readdirSync(agentsDir).filter(f => f.endsWith(".md")).map(f => f.replace(".md", "")))
        : new Set<string>();

      // Check all agent prompts exist and are filled (no TODO stubs)
      for (const [name, state] of Object.entries(skeleton.states)) {
        if (state.type === "agent") {
          if (!agentMdFiles.has(name)) {
            errors.push(`## Missing agent prompt\nState \`${name}\` requires \`.reharness/agents/${name}.md\``);
          } else {
            const content = readFileSync(resolve(agentsDir, `${name}.md`), "utf-8");
            if (content.includes("<!-- TODO")) {
              errors.push(`## Unfilled agent prompt\n\`agents/${name}.md\` is still a stub — write the actual prompt`);
            }
          }
        }
      }

      // Check code state stubs are filled (no TODO remaining)
      const libFiles = existsSync(libDir) ? readdirSync(libDir).filter(f => f.endsWith(".ts")) : [];
      for (const libFile of libFiles) {
        const content = readFileSync(resolve(libDir, libFile), "utf-8");
        const todoMatches = content.match(/\/\/\s*TODO/g);
        if (todoMatches) {
          errors.push(`## Unfilled code state stub\n\`lib/${libFile}\` has ${todoMatches.length} TODO stub(s) — implement the logic`);
        }
      }
    } catch {}
  }

  // 4. Check TypeScript compiles
  const tsconfig = resolve(targetDir, "tsconfig.json");
  if (existsSync(tsconfig)) {
    try {
      execSync("npx tsc --noEmit 2>&1", { cwd: targetDir, encoding: "utf-8", timeout: 30000 });
    } catch (err: any) {
      const out = err.stdout || err.stderr || err.message;
      errors.push(`## TypeScript errors\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    }
  }

  // 5. Try to import each command and validate the FSM graph
  for (const cmdFile of commandFiles) {
    const fullPath = resolve(commandsDir, cmdFile);
    try {
      execSync(
        `node --import tsx/esm -e "
          import cmd from '${fullPath}';
          if (!cmd?.run) { console.error('No default export with run()'); process.exit(1); }
          const p = cmd.run(['test-slug', 'test', 'description'], { root: '${targetDir}', agents: '${agentsDir}', cwd: '${targetDir}' });
          if (!p) { console.error('run() returned null'); process.exit(1); }
          console.log('OK: ' + Object.keys(p.states).join(', '));
        "`,
        { encoding: "utf-8", timeout: 10000 },
      );
    } catch (err: any) {
      const out = err.stdout || err.stderr || err.message;
      errors.push(`## FSM validation failed: ${cmdFile}\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    }
  }

  return errors;
}
