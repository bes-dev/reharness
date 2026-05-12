import { definePipeline } from "../../core/fsm.js";
import type { CommandDefinition } from "../../core/types.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { scanProject, formatScanReport } from "../lib/scan.js";
import { verifyGenerated } from "../lib/verify.js";
import { validateSkeleton, type SkeletonJSON } from "../lib/skeleton-schema.js";
import { generateAllFromSkeletons } from "../lib/codegen.js";
import { snapshotSkeletons, regenIfChanged } from "../lib/skeleton-utils.js";

function looksLikePath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("/") || s.startsWith("../") || s.includes("/");
}

export function makeGenerateCommand(metaDir: string): CommandDefinition {
  const agentsDir = resolve(metaDir, "agents");
  const referencesDir = resolve(metaDir, "references");

  return {
    description: 'Generate or modify a reharness FSM',
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
      const skeletonsDir = resolve(reharnessDir, 'skeletons');
      const errorsFile = resolve(genDir, 'verify-errors.md');
      const reviewFile = resolve(genDir, 'review.md');

      // Ensure directories exist once upfront
      const ensureDirs = () => {
        mkdirSync(genDir, { recursive: true });
        mkdirSync(skeletonsDir, { recursive: true });
        mkdirSync(resolve(reharnessDir, 'agents'), { recursive: true });
        mkdirSync(resolve(reharnessDir, 'commands'), { recursive: true });
        mkdirSync(resolve(reharnessDir, 'lib'), { recursive: true });
      };

      return definePipeline({
        config: { target, description, projectMode },
        agents: agentsDir,
        cwd: ctx.cwd,
        logsDir: resolve(genDir, 'logs'),
        initial: 'triage',

        states: {
          // ── Triage: decide NEW or EXISTING path ──
          triage: {
            entry: async (c) => {
              ensureDirs();
              const hasSkeletons = readdirSync(skeletonsDir).some((f: string) => f.endsWith('.json'));

              if (!hasSkeletons) {
                c.emit('No existing harness → creating new');
                return 'NEW';
              }

              c.emit('Existing harness found → triaging');
              const scan = scanProject(target);
              writeFileSync(resolve(genDir, 'scan-report.md'), formatScanReport(target, scan));
              await c.agent('explorer', [
                `Explore this project to understand its codebase.`,
                `Read the quick scan at: ${genDir}/scan-report.md`,
                `The project root is: ${target}`,
                `Write your analysis to: ${genDir}/explore-report.md`,
              ].join('\n'));

              await c.agent('scope', [
                `The user wants: "${description}"`,
                `Read the existing harness at: ${reharnessDir}/`,
                `Read existing skeletons in: ${skeletonsDir}/`,
                `Read project exploration: ${genDir}/explore-report.md`,
                ``,
                `Decide: does this request need a NEW command (new FSM with new skeleton),`,
                `or is it a MODIFICATION of existing commands (edit agents, lib, skeleton)?`,
                ``,
                `If NEW command: write "NEW" as the first line of your response file.`,
                `If MODIFICATION: write "EXISTING" as the first line.`,
                `Then explain your reasoning.`,
                `Write to: ${genDir}/triage.md`,
              ].join('\n'));

              const triage = existsSync(resolve(genDir, 'triage.md'))
                ? readFileSync(resolve(genDir, 'triage.md'), 'utf-8').trim()
                : '';
              if (triage.startsWith('NEW')) {
                c.emit('→ new command');
                return 'NEW';
              }
              c.emit('→ modify existing');
              return 'EXISTING';
            },
            on: {
              NEW: 'research',
              EXISTING: 'investigate',
            },
          },

          // ══════════════════════════════════════════════
          // NEW PATH: full create flow
          // ══════════════════════════════════════════════

          research: {
            entry: async (c) => {
              const context = existsSync(resolve(genDir, 'explore-report.md'))
                ? `Read the project exploration at: ${genDir}/explore-report.md\nDesign an FSM for THIS project.`
                : `This is a standalone FSM.`;
              await c.agent('research', [
                `Research the domain for: "${description}"`,
                context,
                `Write findings to: ${genDir}/research.md`,
              ].join('\n'));
              c.emit('✓ research');
            },
            on: 'scope_new',
          },

          scope_new: {
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

          skeleton: {
            entry: async (c) => {
              const existingSkeletons = readdirSync(skeletonsDir).filter((f: string) => f.endsWith('.json'));
              const existingNote = existingSkeletons.length > 0
                ? `Read existing skeletons in: ${skeletonsDir}\nYou are adding a NEW command alongside existing ones.`
                : `Create a new skeleton.`;
              await c.agent('skeleton', [
                `Design the FSM topology for: "${description}"`,
                `Read scope at: ${genDir}/scope.md`,
                `Read design principles at: ${referencesDir}/design-principles.md`,
                existingNote,
                `Write skeleton JSON to: ${skeletonsDir}/<id>.json (filename = command id)`,
              ].join('\n'));

              const files = readdirSync(skeletonsDir).filter((f: string) => f.endsWith('.json'));
              if (files.length === 0) {
                c.emit('✗ no skeleton created');
                return 'ERROR';
              }
              for (const file of files) {
                try {
                  const skeleton: SkeletonJSON = JSON.parse(readFileSync(resolve(skeletonsDir, file), 'utf-8'));
                  const errs = validateSkeleton(skeleton);
                  if (errs.length > 0) {
                    c.emit(`✗ ${file}: ${errs[0]}`);
                    return 'ERROR';
                  }
                } catch (e: any) {
                  c.emit(`✗ ${file}: ${e.message}`);
                  return 'ERROR';
                }
              }
              c.emit(`✓ skeleton (${files.length} command(s))`);
            },
            on: { DONE: 'codegen', ERROR: 'error' },
          },

          codegen: {
            entry: async (c) => {
              generateAllFromSkeletons(reharnessDir);
              c.emit('✓ codegen');
            },
            on: 'prompts',
          },

          prompts: {
            entry: async (c) => {
              const hasReview = existsSync(reviewFile);
              await c.agent('prompts', [
                `Write agent prompts and code state logic for the FSM.`,
                `Read ALL skeleton JSONs in: ${skeletonsDir}/`,
                `Read scope: ${genDir}/scope.md`,
                `Read research: ${genDir}/research.md`,
                `Read the generated command files in: ${reharnessDir}/commands/`,
                `Read the lib stubs in: ${reharnessDir}/lib/`,
                `Write agent prompts to: ${reharnessDir}/agents/`,
                `Fill in code state logic in: ${reharnessDir}/lib/`,
                ...(hasReview ? [``, `IMPORTANT: A review found issues. Read: ${reviewFile}`, `Address ALL issues listed there.`] : []),
              ].join('\n'));
              c.emit('✓ prompts');
            },
            on: 'review',
          },

          review: {
            entry: async (c) => {
              await c.agent('review', [
                `Review the generated FSM against its specification.`,
                `Read the scope (spec): ${genDir}/scope.md`,
                `Read ALL skeletons in: ${skeletonsDir}/`,
                `Read ALL agent prompts in: ${reharnessDir}/agents/`,
                `Read ALL code state logic in: ${reharnessDir}/lib/`,
                `Write your review report to: ${reviewFile}`,
              ].join('\n'));
              const report = existsSync(reviewFile)
                ? readFileSync(reviewFile, 'utf-8').trim()
                : '';
              if (report.startsWith('PASS')) {
                c.emit('✓ review passed');
                return 'PASS';
              }
              c.emit('✗ review found issues');
              return 'FAIL';
            },
            on: {
              PASS: 'verify',
              FAIL: [
                { target: 'review_fix', guard: (c) => c.retries('review') < 2 },
                { target: 'verify' },
              ],
            },
          },

          review_fix: {
            entry: async (c) => {
              c.retry('review');
              c.data.skeletonsBefore = snapshotSkeletons(skeletonsDir);
              await c.agent('investigator', [
                `A review found issues with the generated FSM. Fix them.`,
                `Read the review report: ${reviewFile}`,
                `Read the scope (spec): ${genDir}/scope.md`,
                `Read existing skeletons in: ${skeletonsDir}/`,
                `Read design principles: ${referencesDir}/design-principles.md`,
                `Project root: ${target}`,
                ``,
                `Fix the issues from the review. Edit skeletons/*.json for structural changes,`,
                `agents/*.md for prompt changes, lib/*.ts for code logic changes.`,
                `Write a summary of changes to: ${genDir}/changes.md`,
              ].join('\n'));
              if (regenIfChanged(skeletonsDir, reharnessDir, c.data.skeletonsBefore as Record<string, string>)) {
                c.emit('✓ regenerated commands after review fix');
              }
              c.emit('✓ review issues fixed');
            },
            on: 'review',
          },

          // ══════════════════════════════════════════════
          // EXISTING PATH: investigate → regen → verify
          // ══════════════════════════════════════════════

          investigate: {
            entry: async (c) => {
              c.data.skeletonsBefore = snapshotSkeletons(skeletonsDir);
              await c.agent('investigator', [
                `The user wants: "${description}"`,
                `Read the existing harness at: ${reharnessDir}/`,
                `Read existing skeletons in: ${skeletonsDir}/`,
                `Read design principles: ${referencesDir}/design-principles.md`,
                `Project root: ${target}`,
                ``,
                `Make the requested changes. Edit skeletons/*.json for structural changes,`,
                `agents/*.md for prompt changes, lib/*.ts for code logic changes.`,
                `Write a summary of changes to: ${genDir}/changes.md`,
              ].join('\n'));
              c.emit('✓ investigated');
            },
            on: 'regen',
          },

          regen: {
            entry: async (c) => {
              if (regenIfChanged(skeletonsDir, reharnessDir, c.data.skeletonsBefore as Record<string, string>)) {
                c.emit('✓ regenerated commands');
              }
            },
            on: 'verify',
          },

          // ══════════════════════════════════════════════
          // SHARED: verify ↔ fix → done/error
          // ══════════════════════════════════════════════

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
                `Fix errors in the FSM.`,
                `Read errors: ${errorsFile}`,
                `Read skeletons in: ${skeletonsDir}/`,
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
              c.emit('FSM GENERATED');
              if (c.config.projectMode) {
                c.emit('  reharness    # see available commands');
              } else {
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
