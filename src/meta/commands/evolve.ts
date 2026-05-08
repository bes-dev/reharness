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
    execSync("git add .pi-fsm/", { cwd, stdio: "ignore" });
    execSync(`git commit -m "${message}" --allow-empty`, { cwd, stdio: "ignore" });
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch { return null; }
}

export function makeEvolveCommand(metaDir: string): CommandDefinition {
  const agentsDir = resolve(metaDir, "agents");
  const referencesDir = resolve(metaDir, "references");

  return {
    description: 'Analyze run logs and improve pipeline (prompts, verify, scaffold, graph)',
    usage: '[--auto] [--interactive]',

    run: (args, ctx) => {
      const autoMode = args.includes("--auto");
      const interactive = args.includes("--interactive");
      if (interactive && !hasTmux()) {
        console.error("--interactive requires tmux. Run pi-fsm inside a tmux session.");
        return null;
      }
      const target = ctx.cwd;
      const evolveDir = resolve(target, '.pi-fsm', 'evolve');
      const errorsFile = resolve(evolveDir, 'verify-errors.md');
      const reportFile = resolve(evolveDir, 'evolve-report.md');

      return definePipeline({
        config: { target, autoMode, interactive },
        agents: agentsDir,
        cwd: ctx.cwd,
        logsDir: resolve(evolveDir, 'logs'),
        initial: 'read_logs',

        states: {
          read_logs: {
            entry: async (c) => {
              c.status('Reading run logs...');
              const logs = readProjectLogs(target);
              if (logs.length === 0) {
                c.emit('✗ No run logs found. Run a pipeline first, then evolve.');
                return 'EMPTY';
              }
              mkdirSync(evolveDir, { recursive: true });
              const input = formatEvolutionInput(target, logs);
              writeFileSync(resolve(evolveDir, 'evolution-input.md'), input);
              c.data.runCount = logs.length;
              c.data.reportLines = [`# Evolve Report\n`, `## Input`, `- Runs analyzed: ${logs.length}`, `- Retries found: ${Object.keys(logs.flatMap(l => Object.keys(l.retries)).reduce((a: any, k) => { a[k] = true; return a; }, {})).join(', ') || 'none'}`, ''];
              c.emit(`✓ ${logs.length} run(s) analyzed`);
            },
            on: {
              DONE: 'git_snapshot_before',
              EMPTY: 'done_no_changes',
            },
          },

          git_snapshot_before: {
            entry: async (c) => {
              if (gitAvailable(target)) {
                const sha = gitSnapshot(target, 'pi-fsm evolve: pre-evolution snapshot');
                if (sha) {
                  c.data.beforeSha = sha;
                  c.emit(`✓ git snapshot: ${sha.slice(0, 8)}`);
                  c.data.reportLines.push('## Git', `- Pre-evolution commit: ${sha}`, '');
                }
              } else {
                c.emit('⚠ not a git repo — changes cannot be rolled back');
                c.data.reportLines.push('## Git', '- No git repo — rollback not available', '');
              }
            },
            on: 'classify',
          },

          classify: {
            entry: async (c) => {
              await c.agent('log-analyzer', [
                `Analyze pipeline execution logs and classify patterns.`,
                `Read evolution input: ${evolveDir}/evolution-input.md`,
                `Read all pipeline files in: ${target}/.pi-fsm/`,
                `Write classification to: ${evolveDir}/evolution-plan.md`,
              ].join('\n'));
              c.data.reportLines.push('## Classification', '- Patterns classified in: .pi-fsm/evolve/evolution-plan.md', '');
            },
            on: {
              DONE: [
                { target: 'interactive_review', guard: (c) => c.config.interactive },
                { target: 'plan_patches' },
              ],
            },
          },

          interactive_review: {
            entry: async (c) => {
              c.emit('Opening interactive session — review evolution plan with agent');
              await c.interactive('evolution-planner', [
                `Review the evolution plan with the user.`,
                `The plan is at: ${evolveDir}/evolution-plan.md`,
                `Current pipeline files are in: ${target}/.pi-fsm/`,
                `Pipeline design guide: ${referencesDir}/pipeline-design-guide.md`,
                ``,
                `Discuss the proposed changes with the user. They can:`,
                `- Accept, reject, or modify individual patterns`,
                `- Suggest additional improvements`,
                `- Ask questions about the analysis`,
                ``,
                `After discussion, update ${evolveDir}/patches.md with the agreed patches.`,
              ].join('\n'));
              c.data.reportLines.push('## Interactive Review', '- User reviewed and approved patches in interactive session', '');
            },
            on: 'apply_patches',
          },

          plan_patches: {
            entry: async (c) => {
              await c.agent('evolution-planner', [
                `Design specific patches for the pipeline.`,
                `Read evolution plan: ${evolveDir}/evolution-plan.md`,
                `Read pipeline design guide: ${referencesDir}/pipeline-design-guide.md`,
                `Read all current pipeline files in: ${target}/.pi-fsm/`,
                `Write patches to: ${evolveDir}/patches.md`,
              ].join('\n'));
              c.data.reportLines.push('## Patches Planned', '- See: .pi-fsm/evolve/patches.md', '');
            },
            on: 'apply_patches',
          },

          apply_patches: {
            entry: async (c) => {
              await c.agent('patcher', [
                `Apply patches to the pipeline.`,
                `Read patches: ${evolveDir}/patches.md`,
                `Apply changes to files in: ${target}/.pi-fsm/`,
              ].join('\n'));
            },
            on: 'verify_patches',
          },

          verify_patches: {
            entry: async (c) => {
              const errors = verifyGenerated(target);
              if (errors.length > 0) {
                writeFileSync(errorsFile, '# Evolve Verify Errors\n\n' + errors.join('\n\n') + '\n');
                c.emit(`✗ ${errors.length} error(s) after patching`);
                return 'FAIL';
              }
              c.emit('✓ patched pipeline verified');
              c.data.reportLines.push('## Verification', '- All checks passed after patching', '');
              return 'PASS';
            },
            on: {
              PASS: 'git_snapshot_after',
              FAIL: [
                { target: 'fix_patches', guard: (c) => c.retries('verify') < 2 },
                { target: 'error' },
              ],
            },
          },

          fix_patches: {
            entry: async (c) => {
              c.retry('verify');
              await c.agent('fix', [
                `Fix errors introduced by evolution patches.`,
                `Read errors: ${errorsFile}`,
                `Fix files in: ${target}/.pi-fsm/`,
              ].join('\n'));
            },
            on: 'verify_patches',
          },

          git_snapshot_after: {
            entry: async (c) => {
              if (gitAvailable(target)) {
                const sha = gitSnapshot(target, 'pi-fsm evolve: post-evolution changes');
                if (sha) {
                  c.data.afterSha = sha;
                  c.emit(`✓ git commit: ${sha.slice(0, 8)}`);
                  c.data.reportLines.push('## Git Commit', `- Post-evolution commit: ${sha}`);
                  if (c.data.beforeSha) {
                    c.data.reportLines.push(`- Rollback: git revert ${sha.slice(0, 8)}`, `- Diff: git diff ${(c.data.beforeSha as string).slice(0, 8)}..${sha.slice(0, 8)}`);
                  }
                  c.data.reportLines.push('');
                }
              }
            },
            on: 'finalize',
          },

          finalize: {
            entry: async (c) => {
              if (c.config.autoMode) {
                const configPath = resolve(target, '.pi-fsm', 'config.json');
                let config: Record<string, any> = {};
                if (existsSync(configPath)) {
                  try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
                }
                config.autoEvolve = true;
                writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
                c.emit('✓ auto-evolve enabled');
                c.data.reportLines.push('## Auto-Evolve', '- Enabled: will analyze after each run', '');
              }

              // Write report
              const lines = c.data.reportLines as string[];
              lines.push('## Result', '- Status: SUCCESS');
              writeFileSync(reportFile, lines.join('\n') + '\n');
              c.emit(`✓ report: .pi-fsm/evolve/evolve-report.md`);
            },
            on: 'done',
          },

          done: {
            type: 'final',
            status: 'success',
            entry: async (c) => {
              c.emit('');
              c.emit('PIPELINE EVOLVED');
              c.emit(`  Report: .pi-fsm/evolve/evolve-report.md`);
              if (c.data.afterSha) {
                c.emit(`  Rollback: git revert ${(c.data.afterSha as string).slice(0, 8)}`);
              }
            },
          },

          done_no_changes: {
            type: 'final',
            status: 'success',
            entry: async (c) => {
              c.emit('No logs to analyze. Nothing to evolve.');
            },
          },

          error: { type: 'final', status: 'error' },
        },
      });
    },
  };
}
