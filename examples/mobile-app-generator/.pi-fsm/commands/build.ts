import { defineCommand, definePipeline } from 'pi-fsm';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { scaffold } from '../lib/scaffold.js';
import { smokeTest } from '../lib/smoke.js';

export default defineCommand({
  description: 'Build a new app from scratch',
  usage: '<slug> <idea...>',

  run: (args, ctx) => {
    const slug = args[0];
    if (!slug) { console.error('Usage: /build <slug> <app idea>'); return null; }

    const name = slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('');
    const idea = args.slice(1).join(' ');
    if (!idea) { console.error('Usage: /build <slug> <app idea>'); return null; }

    const app = resolve(ctx.root, 'apps', slug);
    const reportFile = resolve(app, 'verify-report.md');

    return definePipeline({
      config: { slug, name, idea },
      agents: ctx.agents,
      cwd: ctx.cwd,
      logsDir: resolve(app, 'logs'),
      initial: 'scaffold',

      states: {
        scaffold: {
          entry: async (c) => {
            const log = await scaffold(ctx.root, slug, name);
            log.forEach(c.emit);
          },
          on: 'prd',
        },

        prd: {
          entry: async (c) => {
            mkdirSync(resolve(app, 'spec'), { recursive: true });
            await c.agent('prd', [
              `Generate a PRD for this app idea: ${idea}`,
              `App slug: ${slug}, App name: ${name}`,
              `Write to: apps/${slug}/spec/prd.md`,
            ].join('\n'));
            if (!existsSync(resolve(app, 'spec/prd.md'))) {
              c.emit('✗ PRD not written');
              return 'ERROR';
            }
          },
          on: { DONE: 'skeleton', ERROR: 'error' },
        },

        skeleton: {
          entry: async (c) => {
            await c.agent('skeleton', [
              `Design the type-level skeleton for apps/${slug}.`,
              `Read the PRD at apps/${slug}/spec/prd.md.`,
              `Create: src/types/, src/services/ (signatures), src/stores/ (stubs).`,
              `All method bodies: throw "skeleton". Run npx tsc --noEmit.`,
            ].join('\n'));
          },
          on: 'logic',
        },

        logic: {
          entry: async (c) => {
            await c.agent('logic', [
              `Implement the data layer for apps/${slug}.`,
              `Read ALL files in apps/${slug}/src/types/ first.`,
              `Replace every throw "skeleton" with real implementations.`,
              `Do NOT modify src/types/. Run npx tsc --noEmit.`,
            ].join('\n'));
          },
          on: 'ui',
        },

        ui: {
          entry: async (c) => {
            await c.agent('ui', [
              `Build the UI for apps/${slug}.`,
              `Read: apps/${slug}/spec/prd.md (especially §6 Visual Style), src/types/, src/stores/.`,
              `Update app/_layout.tsx theme to match PRD §6 Visual Style (dark/light, accent color, surface colors).`,
              `Do NOT modify: package.json, tsconfig.json, app.config.js, babel.config.js.`,
              `Do NOT create: app.json, App.tsx — they conflict with Expo Router.`,
              `Create: src/components/, app/(tabs)/, app/index.tsx, detail screens in app/.`,
              `Run npx tsc --noEmit.`,
            ].join('\n'));
          },
          on: 'verify',
        },

        verify: {
          entry: async (c) => {
            const report: string[] = [];

            c.status('Verifying: tsc...');
            try {
              execSync(`cd apps/${slug} && npx tsc --noEmit 2>&1`, { encoding: 'utf-8', timeout: 120000 });
              c.emit('✓ tsc');
            } catch (err: any) {
              c.emit('✗ tsc');
              report.push('## tsc errors\n```\n' + (err.stdout || err.stderr || err.message) + '\n```');
            }

            c.status('Verifying: bundle...');
            try {
              execSync(`cd apps/${slug} && npx expo export --platform ios 2>&1`, { encoding: 'utf-8', timeout: 120000 });
              c.emit('✓ bundle');
            } catch (err: any) {
              c.emit('✗ bundle');
              report.push('## bundle errors\n```\n' + (err.stdout || err.stderr || err.message) + '\n```');
            }

            if (report.length === 0) {
              c.status('Verifying: smoke test...');
              const smokeErrors: string[] = [];
              const smokeOk = await smokeTest(resolve(ctx.root, 'apps', slug), (msg) => {
                c.emit(msg);
                if (msg.startsWith('✗') || msg.startsWith('  ')) smokeErrors.push(msg);
              });
              if (!smokeOk) {
                report.push('## smoke test errors (runtime)\n```\n' + smokeErrors.join('\n') + '\n```');
                report.push('This is a RUNTIME error — tsc and bundle pass but the app crashes when loaded.');
              }
            }

            if (report.length === 0) {
              c.status('Verifying: stubs...');
              try {
                const stubs = execSync(
                  `grep -rn "TODO\\|STUB\\|FIXME\\|throw.*skeleton" apps/${slug}/src/ apps/${slug}/app/ 2>/dev/null | grep -v node_modules || true`,
                  { encoding: 'utf-8', cwd: ctx.root },
                ).trim();
                if (stubs) {
                  c.emit('✗ stubs found');
                  report.push('## stubs found\n```\n' + stubs + '\n```');
                } else {
                  c.emit('✓ no stubs');
                }
              } catch {}
            }

            c.status('Verifying: antipatterns...');
            const antipatterns: string[] = [];
            if (existsSync(resolve(app, 'app.json')))
              antipatterns.push('app.json exists — delete it. Conflicts with app.config.js.');
            if (existsSync(resolve(app, 'App.tsx')))
              antipatterns.push('App.tsx exists — delete it. Conflicts with Expo Router.');
            try {
              const badSafe = execSync(
                `grep -rn "from 'react-native'" apps/${slug}/app/ apps/${slug}/src/ 2>/dev/null | grep SafeAreaView || true`,
                { encoding: 'utf-8', cwd: ctx.root },
              ).trim();
              if (badSafe) antipatterns.push('SafeAreaView from react-native (deprecated):\n```\n' + badSafe + '\n```');
            } catch {}
            if (antipatterns.length > 0) {
              c.emit(`✗ ${antipatterns.length} antipattern(s)`);
              report.push('## antipatterns\n\n' + antipatterns.map((a, i) => `${i + 1}. ${a}`).join('\n\n'));
            }

            if (report.length > 0) {
              writeFileSync(reportFile, '# Verify Report\n\n' + report.join('\n\n') + '\n');
              c.emit(`Report: apps/${slug}/verify-report.md`);
              return 'FAIL';
            }
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
              `Fix errors in apps/${slug}.`,
              `Read the verify report at apps/${slug}/verify-report.md — it contains the EXACT errors to fix.`,
              `Read PRD at apps/${slug}/spec/prd.md for context.`,
              `After fixing, run: npx tsc --noEmit to confirm type errors are resolved.`,
            ].join('\n'));
          },
          on: 'verify',
        },

        complete: {
          type: 'final',
          status: 'success',
          entry: async (c) => {
            c.emit('');
            c.emit('BUILD COMPLETE');
            c.emit(`  cd apps/${slug} && npx expo start`);
          },
        },

        error: { type: 'final', status: 'error' },
      },
    });
  },
});
