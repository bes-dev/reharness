import { definePipeline } from "../../core/fsm.js";
import type { CommandDefinition } from "../../core/types.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { scanProject, formatScanReport } from "../lib/scan.js";
import { verifyGenerated } from "../lib/verify.js";

function looksLikePath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("/") || s.startsWith("../") || s.includes("/");
}

export function makeGenerateCommand(metaDir: string): CommandDefinition {
  const agentsDir = resolve(metaDir, "agents");
  const referencesDir = resolve(metaDir, "references");

  return {
    description: 'Generate a pi-fsm pipeline from a prompt',
    usage: '[output-dir] <description...>',

    run: (args, ctx) => {
      if (args.length === 0) { console.error('Usage: /generate [output-dir] <description...>'); return null; }

      // If first arg looks like a path → standalone mode (new dir)
      // Otherwise → project mode (generate into current .pi-fsm/)
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

      const piFsmDir = resolve(target, '.pi-fsm');
      const genDir = resolve(piFsmDir, 'generate');
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

              // Quick structural scan
              const scan = scanProject(target);
              writeFileSync(resolve(genDir, 'scan-report.md'), formatScanReport(target, scan));

              // Deep exploration by agent
              await c.agent('explorer', [
                `Explore this project to understand its codebase.`,
                `Read the quick scan at: ${genDir}/scan-report.md`,
                `The project root is: ${target}`,
                `Write your analysis to: ${genDir}/explore-report.md`,
              ].join('\n'));
              c.emit('✓ project explored');
            },
            on: 'research',
          },

          // ── Research (both modes) ──

          research: {
            entry: async (c) => {
              mkdirSync(genDir, { recursive: true });
              const contextNote = c.config.projectMode
                ? `Read the project exploration at: ${genDir}/explore-report.md\nGenerate a pipeline command for THIS project.`
                : `This is a standalone pipeline (no existing project).`;
              await c.agent('research', [
                `Research the domain for building this pipeline:`,
                `"${description}"`,
                ``,
                contextNote,
                `Write your findings to: ${genDir}/research.md`,
              ].join('\n'));
            },
            on: 'design',
          },

          design: {
            entry: async (c) => {
              const contextNote = c.config.projectMode
                ? `Read the project exploration at: ${genDir}/explore-report.md`
                : '';
              await c.agent('design', [
                `Design an FSM pipeline for:`,
                `"${description}"`,
                ``,
                `Read the design reference guide at: ${referencesDir}/pipeline-design-guide.md`,
                `Read research at: ${genDir}/research.md`,
                contextNote,
                `Write design to: ${genDir}/design.md`,
              ].filter(Boolean).join('\n'));
            },
            on: 'generate_prompts',
          },

          generate_prompts: {
            entry: async (c) => {
              mkdirSync(resolve(piFsmDir, 'agents'), { recursive: true });
              await c.agent('generate-prompts', [
                `Generate agent prompt files for the pipeline.`,
                `Read design: ${genDir}/design.md`,
                `Write .md files to: ${piFsmDir}/agents/`,
              ].join('\n'));
            },
            on: 'generate_pipeline',
          },

          generate_pipeline: {
            entry: async (c) => {
              mkdirSync(resolve(piFsmDir, 'commands'), { recursive: true });
              mkdirSync(resolve(piFsmDir, 'lib'), { recursive: true });
              await c.agent('generate-pipeline', [
                `Generate the pipeline TypeScript code.`,
                `Read design: ${genDir}/design.md`,
                `Read agent prompts: ${piFsmDir}/agents/`,
                `Write commands to: ${piFsmDir}/commands/`,
                `Write lib helpers to: ${piFsmDir}/lib/ (if needed)`,
              ].join('\n'));
            },
            on: 'verify',
          },

          verify: {
            entry: async (c) => {
              const errors = verifyGenerated(target);
              if (errors.length > 0) {
                writeFileSync(errorsFile, '# Verify Errors\n\n' + errors.join('\n\n') + '\n');
                c.emit(`✗ ${errors.length} error(s)`);
                return 'FAIL';
              }
              c.emit('✓ all checks passed');
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
                `Fix errors in the generated pipeline.`,
                `Read errors: ${errorsFile}`,
                `Read design: ${genDir}/design.md`,
                `Fix files in: ${piFsmDir}/`,
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
                c.emit('COMMAND GENERATED');
                c.emit('  pi-fsm    # see available commands');
              } else {
                c.emit('PIPELINE GENERATED');
                c.emit(`  cd ${target} && pi-fsm`);
              }
            },
          },

          error: { type: 'final', status: 'error' },
        },
      });
    },
  };
}
