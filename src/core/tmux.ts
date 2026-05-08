import { execSync, spawn } from "child_process";
import { createReadStream, mkdirSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

export function spawnInTmux(config: TmuxSpawnConfig): TmuxHandle {
  const id = `pi-fsm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = tmpdir();
  const exitFile = join(tmp, `${id}.exit`);
  const fifoPath = join(tmp, `${id}.fifo`);
  const signal = `${id}-done`;

  if (config.interactive) {
    // Interactive: no JSON mode, user interacts directly in pane
    const cmd = config.binary + " " + config.args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const logArg = config.logFile ? ` ; tmux pipe-pane -t ${id} ''` : "";
    const wrapper = `${cmd}; echo $? > '${exitFile}'${logArg}; tmux wait-for -S '${signal}'`;

    execSync(`tmux split-window -v -d -t '{last}' -P -F '#{pane_id}' '${wrapper.replace(/'/g, "'\\''")}'`, {
      cwd: config.cwd,
      encoding: "utf-8",
    }).trim();

    if (config.logFile) {
      mkdirSync(join(config.logFile, ".."), { recursive: true });
      try {
        execSync(`tmux pipe-pane -o -t '{last}' "cat >> '${config.logFile}'"`, { stdio: "ignore" });
      } catch {}
    }

    const done = waitForSignal(signal, exitFile, config.signal);
    return {
      jsonStream: null,
      done,
      cleanup: () => safeUnlink(exitFile),
    };
  }

  // Headless-in-tmux: JSON mode with FIFO for parsing
  execSync(`mkfifo '${fifoPath}'`);

  const cmd = config.binary + " " + config.args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const wrapper = `${cmd} | tee '${fifoPath}'; echo \${PIPESTATUS[0]} > '${exitFile}'; tmux wait-for -S '${signal}'`;

  execSync(`tmux split-window -v -d -t '{last}' '${wrapper.replace(/'/g, "'\\''")}'`, {
    cwd: config.cwd,
    encoding: "utf-8",
  });

  const jsonStream = createReadStream(fifoPath, { encoding: "utf-8" });
  const done = waitForSignal(signal, exitFile, config.signal);

  return {
    jsonStream,
    done,
    cleanup: () => { safeUnlink(fifoPath); safeUnlink(exitFile); },
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
