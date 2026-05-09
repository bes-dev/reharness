import { execSync, spawn } from "child_process";
import { createReadStream, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "fs";
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

function writeScript(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o755 });
}

export function spawnInTmux(config: TmuxSpawnConfig): TmuxHandle {
  const id = `reharness-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = tmpdir();
  const exitFile = join(tmp, `${id}.exit`);
  const fifoPath = join(tmp, `${id}.fifo`);
  const scriptFile = join(tmp, `${id}.sh`);
  const signal = `${id}-done`;

  // Write args to a JSON file so the script can read them without shell escaping
  const argsFile = join(tmp, `${id}.args.json`);
  writeFileSync(argsFile, JSON.stringify(config.args));

  if (config.interactive) {
    writeScript(scriptFile, [
      `#!/usr/bin/env bash`,
      `cd ${JSON.stringify(config.cwd)}`,
      `ARGS=$(cat ${JSON.stringify(argsFile)})`,
      `eval ${JSON.stringify(config.binary)} $(node -e "JSON.parse(require('fs').readFileSync('${argsFile}','utf8')).forEach(a=>process.stdout.write(JSON.stringify(a)+' '))")`,
      `echo $? > ${JSON.stringify(exitFile)}`,
      `tmux wait-for -S '${signal}'`,
    ].join("\n"));

    if (config.logFile) {
      mkdirSync(dirname(config.logFile), { recursive: true });
    }

    execSync(`tmux split-window -v -d -t '{last}' ${JSON.stringify(scriptFile)}`, {
      cwd: config.cwd,
      encoding: "utf-8",
    });

    if (config.logFile) {
      try {
        execSync(`tmux pipe-pane -o -t '{last}' "cat >> ${JSON.stringify(config.logFile)}"`, { stdio: "ignore" });
      } catch {}
    }

    const done = waitForSignal(signal, exitFile, config.signal);
    return {
      jsonStream: null,
      done,
      cleanup: () => { safeUnlink(exitFile); safeUnlink(scriptFile); safeUnlink(argsFile); },
    };
  }

  // Headless-in-tmux: JSON mode with FIFO for parsing
  execSync(`mkfifo ${JSON.stringify(fifoPath)}`);

  writeScript(scriptFile, [
    `#!/usr/bin/env bash`,
    `cd ${JSON.stringify(config.cwd)}`,
    `${config.binary} $(node -e "JSON.parse(require('fs').readFileSync('${argsFile}','utf8')).forEach(a=>process.stdout.write(JSON.stringify(a)+' '))") | tee ${JSON.stringify(fifoPath)}`,
    `echo \${PIPESTATUS[0]} > ${JSON.stringify(exitFile)}`,
    `tmux wait-for -S '${signal}'`,
  ].join("\n"));

  execSync(`tmux split-window -v -d -t '{last}' ${JSON.stringify(scriptFile)}`, {
    cwd: config.cwd,
    encoding: "utf-8",
  });

  const jsonStream = createReadStream(fifoPath, { encoding: "utf-8" });
  const done = waitForSignal(signal, exitFile, config.signal);

  return {
    jsonStream,
    done,
    cleanup: () => { safeUnlink(fifoPath); safeUnlink(exitFile); safeUnlink(scriptFile); safeUnlink(argsFile); },
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
