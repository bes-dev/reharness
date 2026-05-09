import { definePipeline } from "../../core/fsm.js";
import { hasTmux } from "../../core/tmux.js";
import type { CommandDefinition } from "../../core/types.js";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { readProjectLogs, formatEvolutionInput } from "../lib/logs.js";
import { verifyGenerated } from "../lib/verify.js";

function gitAvailable(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function gitSnapshot(cwd: string, message: string): string | null {
  try {
    execSync("git add .reharness/", { cwd, stdio: "ignore", timeout: 30000 });
    execSync(`git commit -m "${message}" --allow-empty`, { cwd, stdio: "ignore", timeout: 30000 });
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", timeout: 10000 }).trim();
  } catch { return null; }
}

export function makeEvolveCommand(metaDir: string): CommandDefinition {
  const agentsDir = resolve(metaDir, "agents");

  return {
    description: 'Analyze run logs and improve pipeline',
    usage: '[--auto] [--interactive]',

    run: (args, ctx) => {
      const autoMode = args.includes("--auto");
      const interactive = args.includes("--interactive");
      if (interactive && !hasTmux()) {
        console.error("--interactive requires tmux. Run reharness inside a tmux session.");
        return null;
      }
      const target = ctx.cwd;
      const evolveDir = resolve(target, '.reharness', 'evolve');
      const errorsFile = resolve(evolveDir, 'verify-errors.md');

      return definePipeline({
        config: { target, autoMode, interactive },
        agents: agentsDir,
        cwd: ctx.cwd,
        logsDir: resolve(evolveDir, 'logs'),
        initial: 'read_logs',

        states: {
          read_logs: {
            entry: async (c) => {
              c.status('Reading logs...');
              const logs = readProjectLogs(target);
              if (logs.length === 0) {
                c.emit('No run logs found. Run a pipeline first.');
                return 'EMPTY';
              }
              mkdirSync(evolveDir, { recursive: true });
              writeFileSync(resolve(evolveDir, 'evolution-input.md'), formatEvolutionInput(target, logs));
              c.emit(`✓ ${logs.length} run(s)`);

              // Git snapshot before changes
              if (gitAvailable(target)) {
                const sha = gitSnapshot(target, 'reharness evolve: pre-evolution');
                if (sha) { c.data.beforeSha = sha; c.emit(`✓ git: ${sha.slice(0, 8)}`); }
              }
            },
            on: { DONE: 'analyze', EMPTY: 'done_empty' },
          },

          analyze: {
            entry: async (c) => {
              const method = c.config.interactive ? 'interactive' : 'agent' as const;
              await c[method]('analyzer', [
                `Analyze pipeline logs and plan patches.`,
                `Read evolution input: ${evolveDir}/evolution-input.md`,
                `Read all pipeline files in: ${target}/.reharness/`,
                `Write patches to: ${evolveDir}/patches.md`,
              ].join('\n'));
              c.emit('✓ analyzed');
            },
            on: 'patch',
          },

          patch: {
            entry: async (c) => {
              // Check if analyzer found anything to patch
              const patchFile = resolve(evolveDir, 'patches.md');
              if (!existsSync(patchFile)) {
                c.emit('No patches needed.');
                return 'SKIP';
              }
              const content = readFileSync(patchFile, 'utf-8');
              if (content.includes('No changes needed') || content.includes('No Changes Needed')) {
                c.emit('No patches needed.');
                return 'SKIP';
              }
              await c.agent('fix', [
                `Apply the patches described in: ${evolveDir}/patches.md`,
                `Modify files in: ${target}/.reharness/`,
              ].join('\n'));
              c.emit('✓ patched');
            },
            on: { DONE: 'verify', SKIP: 'done' },
          },

          verify: {
            entry: async (c) => {
              const errors = verifyGenerated(target);
              if (errors.length > 0) {
                writeFileSync(errorsFile, '# Evolve Errors\n\n' + errors.join('\n\n') + '\n');
                c.emit(`✗ ${errors.length} error(s)`);
                return 'FAIL';
              }
              c.emit('✓ verified');

              // Git snapshot after changes
              if (gitAvailable(target)) {
                const sha = gitSnapshot(target, 'reharness evolve: post-evolution');
                if (sha) {
                  c.data.afterSha = sha;
                  c.emit(`✓ git: ${sha.slice(0, 8)}`);
                }
              }
              return 'PASS';
            },
            on: {
              PASS: 'done',
              FAIL: [
                { target: 'fix', guard: (c) => c.retries('verify') < 2 },
                { target: 'error' },
              ],
            },
          },

          fix: {
            entry: async (c) => {
              c.retry('verify');
              await c.agent('fix', [
                `Fix errors from evolution.`,
                `Read errors: ${errorsFile}`,
                `Fix files in: ${target}/.reharness/`,
              ].join('\n'));
            },
            on: 'verify',
          },

          done: {
            type: 'final',
            status: 'success',
            entry: async (c) => {
              c.emit('');
              c.emit('EVOLVED');
              if (c.data.afterSha) c.emit(`  Rollback: git revert ${(c.data.afterSha as string).slice(0, 8)}`);
              c.emit(`  Details: .reharness/evolve/patches.md`);
            },
          },

          done_empty: {
            type: 'final',
            status: 'success',
          },

          error: { type: 'final', status: 'error' },
        },
      });
    },
  };
}
