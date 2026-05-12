import { definePipeline } from "../../core/fsm.js";
import type { CommandDefinition } from "../../core/types.js";
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { writeInvestigationBrief } from "../lib/logs.js";
import { verifyGenerated } from "../lib/verify.js";
import { snapshotSkeletons, regenIfChanged } from "../lib/skeleton-utils.js";

function gitAvailable(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function gitSnapshot(cwd: string, message: string): string | null {
  try {
    execFileSync("git", ["add", ".reharness/"], { cwd, stdio: "ignore", timeout: 30000 });
    execFileSync("git", ["commit", "-m", message, "--allow-empty"], { cwd, stdio: "ignore", timeout: 30000 });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", timeout: 10000 }).trim();
  } catch { return null; }
}

export function makeEvolveCommand(metaDir: string): CommandDefinition {
  const agentsDir = resolve(metaDir, "agents");
  const referencesDir = resolve(metaDir, "references");

  return {
    description: 'Investigate FSM runs and improve the machine',
    usage: '[--interactive]',

    run: (args, ctx) => {
      const interactive = args.includes("--interactive");
      const target = ctx.cwd;
      const reharnessDir = resolve(target, '.reharness');
      const evolveDir = resolve(reharnessDir, 'evolve');
      const briefFile = resolve(evolveDir, 'investigation-brief.md');
      const patchesFile = resolve(evolveDir, 'patches.md');
      const errorsFile = resolve(evolveDir, 'verify-errors.md');
      const skeletonsDir = resolve(reharnessDir, 'skeletons');

      return definePipeline({
        config: { target, interactive },
        agents: agentsDir,
        cwd: ctx.cwd,
        logsDir: resolve(evolveDir, 'logs'),
        initial: 'brief',

        states: {
          // ── Brief: find logs, write paths, git snapshot ──
          brief: {
            entry: async (c) => {
              mkdirSync(evolveDir, { recursive: true });
              const runCount = writeInvestigationBrief(target, briefFile);
              if (runCount === 0) {
                c.emit('No run logs found.');
                return 'EMPTY';
              }
              c.emit(`✓ ${runCount} run(s) found`);

              if (gitAvailable(target)) {
                const sha = gitSnapshot(target, 'reharness evolve: pre-investigation');
                if (sha) { c.data.beforeSha = sha; c.emit(`✓ git: ${sha.slice(0, 8)}`); }
              }
            },
            on: { DONE: 'investigate', EMPTY: 'done_empty' },
          },

          // ── Investigate: agent explores freely ──
          investigate: {
            entry: async (c) => {
              c.data.skeletonsBefore = snapshotSkeletons(skeletonsDir);

              const method = c.config.interactive ? 'interactive' : 'agent' as const;
              await c[method]('investigator', [
                `Investigate this reharness FSM project.`,
                `Read the investigation brief: ${briefFile}`,
                `Read design principles: ${referencesDir}/design-principles.md`,
                `Project root: ${target}`,
                `Write patches to: ${patchesFile}`,
              ].join('\n'));
              c.emit('✓ investigated');
            },
            on: 'patch',
          },

          // ── Patch: apply fixes, regenerate command if skeleton changed ──
          patch: {
            entry: async (c) => {
              if (!existsSync(patchesFile)) {
                c.emit('No patches file written.');
                return 'SKIP';
              }
              const content = readFileSync(patchesFile, 'utf-8');
              if (content.toLowerCase().includes('no changes needed')) {
                c.emit('No changes needed.');
                return 'SKIP';
              }

              // Apply patches
              await c.agent('fix', [
                `Apply the patches described in: ${patchesFile}`,
                `Modify files in: ${reharnessDir}/`,
                `IMPORTANT: for structural FSM changes, edit skeletons/*.json not commands/*.ts`,
              ].join('\n'));
              c.emit('✓ patched');

              if (regenIfChanged(skeletonsDir, reharnessDir, (c.data.skeletonsBefore || {}) as Record<string, string>)) {
                c.emit('✓ regenerated commands from updated skeletons');
              }
            },
            on: { DONE: 'verify', SKIP: 'done' },
          },

          // ── Verify: structural checks + git snapshot ──
          verify: {
            entry: async (c) => {
              const errors = verifyGenerated(target);
              if (errors.length > 0) {
                writeFileSync(errorsFile, '# Evolve Errors\n\n' + errors.join('\n\n') + '\n');
                c.emit(`✗ ${errors.length} error(s)`);
                return 'FAIL';
              }
              c.emit('✓ verified');

              if (gitAvailable(target)) {
                const sha = gitSnapshot(target, 'reharness evolve: post-investigation');
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
                `Fix files in: ${reharnessDir}/`,
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

          done_empty: { type: 'final', status: 'success' },
          error: { type: 'final', status: 'error' },
        },
      });
    },
  };
}
