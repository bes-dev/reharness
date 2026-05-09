import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { resolve } from "path";

export function verifyGenerated(targetDir: string): string[] {
  const errors: string[] = [];

  const commandsDir = resolve(targetDir, ".reharness", "commands");
  const agentsDir = resolve(targetDir, ".reharness", "agents");

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

  // 3. Check TypeScript compiles
  const tsconfig = resolve(targetDir, "tsconfig.json");
  if (existsSync(tsconfig)) {
    try {
      execSync("npx tsc --noEmit 2>&1", { cwd: targetDir, encoding: "utf-8", timeout: 30000 });
    } catch (err: any) {
      const out = err.stdout || err.stderr || err.message;
      errors.push(`## TypeScript errors\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\``);
    }
  }

  // 4. Try to import each command and validate the FSM graph
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
