import { definePipeline } from "../../core/fsm.js";
import type { CommandDefinition } from "../../core/types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { scanProject, formatScanReport } from "../lib/scan.js";
import { verifyGenerated } from "../lib/verify.js";
import { validateSkeleton, type SkeletonJSON } from "../lib/skeleton-schema.js";
import { generateFromSkeleton } from "../lib/codegen.js";

function looksLikePath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("/") || s.startsWith("../") || s.includes("/");
}

export function makeGenerateCommand(metaDir: string): CommandDefinition {
  const agentsDir = resolve(metaDir, "agents");
  const referencesDir = resolve(metaDir, "references");

  return {
    description: 'Generate a reharness FSM from a prompt',
    usage: '[output-dir] <description...>',

    run: (args, ctx) => {
      if (args.length === 0) { console.error('Usage: /generate [output-dir] <description...>'); return null; }

      let target: string;
      let description: string;
      let projectMode: boolean;

      if (args.length >= 2 && looksLikePath(args[0])) {
        target = resolve(ctx.cwd, args[0]);
        description = args.slice(1).join(' ');
        projectMode = false;
      } else {
        target = ctx.cwd;
        description = args.join(' ');
        projectMode = true;
      }

      if (!description) { console.error('Usage: /generate [output-dir] <description...>'); return null; }

      const reharnessDir = resolve(target, '.reharness');
      const genDir = resolve(reharnessDir, 'generate');
      const skeletonFile = resolve(genDir, 'skeleton.json');
      const errorsFile = resolve(genDir, 'verify-errors.md');

      return definePipeline({
        config: { target, description, projectMode },
        agents: agentsDir,
        cwd: ctx.cwd,
        logsDir: resolve(genDir, 'logs'),
        initial: projectMode ? 'explore' : 'research',

        states: {
          // ── Project mode: explore codebase first ──
          explore: {
            entry: async (c) => {
              c.status('Exploring project...');
              mkdirSync(genDir, { recursive: true });
              const scan = scanProject(target);
              writeFileSync(resolve(genDir, 'scan-report.md'), formatScanReport(target, scan));
              await c.agent('explorer', [
                `Explore this project to understand its codebase.`,
                `Read the quick scan at: ${genDir}/scan-report.md`,
                `The project root is: ${target}`,
                `Write your analysis to: ${genDir}/explore-report.md`,
              ].join('\n'));
              c.emit('✓ explored');
            },
            on: 'research',
          },

          // ── Research domain ──
          research: {
            entry: async (c) => {
              mkdirSync(genDir, { recursive: true });
              const context = c.config.projectMode
                ? `Read the project exploration at: ${genDir}/explore-report.md\nDesign an FSM for THIS project.`
                : `This is a standalone FSM.`;
              await c.agent('research', [
                `Research the domain for: "${description}"`,
                context,
                `Write findings to: ${genDir}/research.md`,
              ].join('\n'));
              c.emit('✓ research');
            },
            on: 'scope',
          },

          // ── Scope: structured spec ──
          scope: {
            entry: async (c) => {
              await c.agent('scope', [
                `Write the scope document for: "${description}"`,
                `Read research at: ${genDir}/research.md`,
                `Write scope to: ${genDir}/scope.md`,
              ].join('\n'));
              c.emit('✓ scope');
            },
            on: 'skeleton',
          },

          // ── Skeleton: FSM topology as JSON ──
          skeleton: {
            entry: async (c) => {
              const existingSkeletonNote = existsSync(skeletonFile)
                ? `Read EXISTING skeleton at: ${skeletonFile}\nUpdate it based on the request — add/modify states, don't recreate from scratch.`
                : `Create a new skeleton.`;
              await c.agent('skeleton', [
                `Design the FSM topology for: "${description}"`,
                `Read scope at: ${genDir}/scope.md`,
                `Read design principles at: ${referencesDir}/design-principles.md`,
                existingSkeletonNote,
                `Write skeleton JSON to: ${skeletonFile}`,
              ].join('\n'));

              // Validate skeleton JSON
              if (!existsSync(skeletonFile)) {
                c.emit('✗ skeleton.json not created');
                return 'ERROR';
              }
              try {
                const skeleton: SkeletonJSON = JSON.parse(readFileSync(skeletonFile, 'utf-8'));
                const errors = validateSkeleton(skeleton);
                if (errors.length > 0) {
                  c.emit(`✗ skeleton invalid: ${errors[0]}`);
                  writeFileSync(resolve(genDir, 'skeleton-errors.txt'), errors.join('\n'));
                  return 'ERROR';
                }
                c.emit('✓ skeleton');
              } catch (e: any) {
                c.emit(`✗ skeleton JSON parse error: ${e.message}`);
                return 'ERROR';
              }
            },
            on: {
              DONE: 'codegen',
              ERROR: 'error',
            },
          },

          // ── Codegen: deterministic JSON → TypeScript (no LLM) ──
          codegen: {
            entry: async (c) => {
              mkdirSync(resolve(reharnessDir, 'agents'), { recursive: true });
              mkdirSync(resolve(reharnessDir, 'commands'), { recursive: true });
              mkdirSync(resolve(reharnessDir, 'lib'), { recursive: true });

              const skeleton: SkeletonJSON = JSON.parse(readFileSync(skeletonFile, 'utf-8'));
              generateFromSkeleton(skeleton, reharnessDir);
              c.emit('✓ codegen');
            },
            on: 'prompts',
          },

          // ── Prompts: agent writes .md files + fills code state logic ──
          prompts: {
            entry: async (c) => {
              await c.agent('prompts', [
                `Write agent prompts and code state logic for the FSM.`,
                `Read skeleton JSON: ${skeletonFile}`,
                `Read scope: ${genDir}/scope.md`,
                `Read research: ${genDir}/research.md`,
                `Read the generated command file in: ${reharnessDir}/commands/`,
                `Read the lib stubs in: ${reharnessDir}/lib/`,
                `Write agent prompts to: ${reharnessDir}/agents/`,
                `Fill in code state logic in: ${reharnessDir}/lib/`,
              ].join('\n'));
              c.emit('✓ prompts');
            },
            on: 'verify',
          },

          // ── Verify ──
          verify: {
            entry: async (c) => {
              const errors = verifyGenerated(target);
              if (errors.length > 0) {
                writeFileSync(errorsFile, '# Verify Errors\n\n' + errors.join('\n\n') + '\n');
                c.emit(`✗ ${errors.length} error(s)`);
                return 'FAIL';
              }
              c.emit('✓ verified');
              return 'PASS';
            },
            on: {
              PASS: 'complete',
              FAIL: [
                { target: 'fix', guard: (c) => c.retries('verify') < 3 },
                { target: 'error' },
              ],
            },
          },

          fix: {
            entry: async (c) => {
              c.retry('verify');
              await c.agent('fix', [
                `Fix errors in the generated FSM.`,
                `Read errors: ${errorsFile}`,
                `Read skeleton: ${skeletonFile}`,
                `Fix files in: ${reharnessDir}/`,
              ].join('\n'));
            },
            on: 'verify',
          },

          complete: {
            type: 'final',
            status: 'success',
            entry: async (c) => {
              c.emit('');
              if (c.config.projectMode) {
                c.emit('FSM GENERATED');
                c.emit('  reharness    # see available commands');
              } else {
                c.emit('FSM GENERATED');
                c.emit(`  cd ${target} && reharness`);
              }
            },
          },

          error: { type: 'final', status: 'error' },
        },
      });
    },
  };
}
