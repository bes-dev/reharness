/** Shared terminal presentation: ANSI palette, the pipeline event formatter, and duration formatting.
 *  Used by the CLI, the generate runner, and the FSM runtime so progress output stays consistent. */

export const ansi = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** Format a millisecond duration as "250ms" / "12.3s" / "1m3s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Render one pipeline event line. `── state ──` headers become a spinner+bold line; other lines are
 *  indented and coloured by their leading status glyph (✓ green / ✗ red / ⚠ yellow). */
export function emit(msg: string): void {
  const m = msg.match(/^── (\S+) ──$/);
  if (m) { process.stdout.write(`\r\x1b[K${ansi.cyan("⠋")} ${ansi.bold(m[1])}\n`); return; }
  if (!msg.trim()) return;
  const c = msg[0] === "✓" ? ansi.green : msg[0] === "✗" ? ansi.red : msg[0] === "⚠" ? ansi.yellow : (s: string) => s;
  console.log(`  ${c(msg)}`);
}
