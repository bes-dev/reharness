import { defineCommand, definePipeline } from 'pi-fsm';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

export default defineCommand({
  description: 'Modify an existing app',
  usage: '<slug> <request...>',

  run: (args, ctx) => {
    const slug = args[0];
    if (!slug) { console.error('Usage: /improve <slug> <change request>'); return null; }

    const request = args.slice(1).join(' ');
    if (!request) { console.error('Usage: /improve <slug> <change request>'); return null; }

    const app = resolve(ctx.root, 'apps', slug);
    const reportFile = resolve(app, 'verify-report.md');

    return definePipeline({
      config: { slug, request },
      agents: ctx.agents,
      cwd: ctx.cwd,
      logsDir: resolve(app, 'logs'),
      initial: 'improve',

      states: {
        improve: {
          entry: async (c) => {
            await c.agent('improve', [
              `Modify apps/${slug}: ${request}`,
              `Read PRD at apps/${slug}/spec/prd.md and relevant source files.`,
              `Apply changes. Run npx tsc --noEmit after.`,
            ].join('\n'));
          },
          on: 'verify',
        },

        verify: {
          entry: async (c) => {
            const report: string[] = [];
            try {
              execSync(`cd apps/${slug} && npx tsc --noEmit 2>&1`, { encoding: 'utf-8', timeout: 120000 });
              c.emit('✓ tsc');
            } catch (err: any) {
              c.emit('✗ tsc');
              report.push('## tsc errors\n```\n' + (err.stdout || err.stderr || err.message) + '\n```');
            }

            if (report.length > 0) {
              writeFileSync(reportFile, '# Verify Report\n\n' + report.join('\n\n') + '\n');
              return 'FAIL';
            }
            c.emit('✓ all checks passed');
          },
          on: {
            DONE: 'done',
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
              `Fix errors in apps/${slug}.`,
              `Read the verify report at apps/${slug}/verify-report.md.`,
              `After fixing, run: npx tsc --noEmit to confirm.`,
            ].join('\n'));
          },
          on: 'verify',
        },

        done: {
          type: 'final',
          status: 'success',
          entry: async (c) => { c.emit('IMPROVE COMPLETE'); },
        },

        error: { type: 'final', status: 'error' },
      },
    });
  },
});
