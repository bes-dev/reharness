import { definePipeline } from 'pi-fsm';

export default definePipeline({
  config: { greeting: 'Hello from pi-fsm!' },
  logsDir: './logs',
  initial: 'greet',

  states: {
    greet: {
      entry: async (ctx) => { ctx.emit(ctx.config.greeting); },
      on: 'check',
    },

    check: {
      entry: async (ctx) => {
        const ok = ctx.shell('echo "checks passed"', 'sanity check');
        return ok ? 'PASS' : 'FAIL';
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
      entry: async (ctx) => {
        ctx.retry('check');
        ctx.emit('Fixing...');
      },
      on: 'check',
    },

    done: {
      type: 'final',
      status: 'success',
      entry: async (ctx) => { ctx.emit('All done!'); },
    },

    error: { type: 'final', status: 'error' },
  },
});
