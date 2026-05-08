import { defineCommand, definePipeline } from 'pi-fsm';

export default defineCommand({
  description: 'Hello world — minimal pipeline demo',
  run: (_args, _ctx) => definePipeline({
    config: { greeting: 'Hello from pi-fsm!' },
    initial: 'greet',

    states: {
      greet: {
        entry: async (ctx) => { ctx.emit(ctx.config.greeting); },
        on: 'check',
      },

      check: {
        entry: async (ctx) => {
          return ctx.shell('echo "checks passed"', 'sanity check') ? 'PASS' : 'FAIL';
        },
        on: {
          PASS: 'done',
          FAIL: [
            { target: 'fix', guard: (ctx) => ctx.retries('check') < 2 },
            { target: 'error' },
          ],
        },
      },

      fix: {
        entry: async (ctx) => { ctx.retry('check'); ctx.emit('Fixing...'); },
        on: 'check',
      },

      done: {
        type: 'final',
        status: 'success',
        entry: async (ctx) => { ctx.emit('All done!'); },
      },

      error: { type: 'final', status: 'error' },
    },
  }),
});
