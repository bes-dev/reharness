import { execSync, spawn } from "child_process";
import { createReadStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { Readable } from "stream";

export interface TmuxSpawnConfig {
  binary: string;
  args: string[];
  cwd: string;
  sessionLabel: string;
  logFile?: string;
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface TmuxHandle {
  jsonStream: Readable | null;
  done: Promise<{ exitCode: number }>;
  cleanup: () => void;
}

let _hasTmux: boolean | null = null;

export function hasTmux(): boolean {
  if (_hasTmux !== null) return _hasTmux;
  if (!process.env.TMUX) { _hasTmux = false; return false; }
  try {
    execSync("which tmux", { stdio: "ignore" });
    _hasTmux = true;
  } catch {
    _hasTmux = false;
  }
  return _hasTmux;
}

/** Shell-escape a string for use inside single quotes. */
function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

export function spawnInTmux(config: TmuxSpawnConfig): TmuxHandle {
  const id = `reharness-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = tmpdir();
  const exitFile = join(tmp, `${id}.exit`);
  const fifoPath = join(tmp, `${id}.fifo`);
  const scriptFile = join(tmp, `${id}.sh`);
  const signal = `${id}-done`;

  // Build command with proper escaping inside the script
  const cmdLine = config.binary + " " + config.args.map(a => sq(a)).join(" ");

  if (config.interactive) {
    writeFileSync(scriptFile, [
      `#!/usr/bin/env bash`,
      `cd ${sq(config.cwd)}`,
      cmdLine,
      `echo $? > ${sq(exitFile)}`,
      `tmux wait-for -S '${signal}'`,
    ].join("\n"), { mode: 0o755 });

    if (config.logFile) {
      mkdirSync(dirname(config.logFile), { recursive: true });
    }

    execSync(`tmux split-window -v -d ${sq(scriptFile)}`, {
      cwd: config.cwd,
      encoding: "utf-8",
    });

    if (config.logFile) {
      try {
        execSync(`tmux pipe-pane -o -t '{last}' "cat >> ${sq(config.logFile)}"`, { stdio: "ignore" });
      } catch {}
    }

    const done = waitForSignal(signal, exitFile, config.signal);
    return {
      jsonStream: null,
      done,
      cleanup: () => { safeUnlink(exitFile); safeUnlink(scriptFile); },
    };
  }

  // Headless-in-tmux: JSON mode with FIFO for parsing
  execSync(`mkfifo ${sq(fifoPath)}`);

  writeFileSync(scriptFile, [
    `#!/usr/bin/env bash`,
    `cd ${sq(config.cwd)}`,
    `${cmdLine} | tee ${sq(fifoPath)}`,
    `echo \${PIPESTATUS[0]} > ${sq(exitFile)}`,
    `tmux wait-for -S '${signal}'`,
  ].join("\n"), { mode: 0o755 });

  execSync(`tmux split-window -v -d ${sq(scriptFile)}`, {
    cwd: config.cwd,
    encoding: "utf-8",
  });

  const jsonStream = createReadStream(fifoPath, { encoding: "utf-8" });
  const done = waitForSignal(signal, exitFile, config.signal);

  return {
    jsonStream,
    done,
    cleanup: () => { safeUnlink(fifoPath); safeUnlink(exitFile); safeUnlink(scriptFile); },
  };
}

function waitForSignal(signal: string, exitFile: string, abort?: AbortSignal): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["wait-for", signal], { stdio: "ignore" });

    const onAbort = () => {
      proc.kill("SIGTERM");
      resolve({ exitCode: 130 });
    };
    abort?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", () => {
      abort?.removeEventListener("abort", onAbort);
      let exitCode = 1;
      try { exitCode = parseInt(readFileSync(exitFile, "utf-8").trim(), 10) || 1; } catch {}
      resolve({ exitCode });
    });
  });
}

function safeUnlink(path: string) {
  try { unlinkSync(path); } catch {}
}
