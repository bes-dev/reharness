import { execSync, spawn } from "child_process";
import { createReadStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { Readable } from "stream";

export interface TmuxSpawnConfig {
  binary: string;
  args: string[];
  cwd: string;
  name: string;
  logFile?: string;
  interactive?: boolean;
  signal?: AbortSignal;
}

export interface TmuxHandle {
  jsonStream: Readable | null;
  paneId: string;
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

function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function safeUnlink(path: string) {
  try { unlinkSync(path); } catch {}
}

function killPane(paneId: string) {
  try { execSync(`tmux kill-pane -t ${sq(paneId)}`, { stdio: "ignore" }); } catch {}
}

export function spawnInTmux(config: TmuxSpawnConfig): TmuxHandle {
  const id = `reharness-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = tmpdir();
  const exitFile = join(tmp, `${id}.exit`);
  const fifoPath = join(tmp, `${id}.fifo`);
  const scriptFile = join(tmp, `${id}.sh`);
  const signal = `${id}-done`;
  const cmdLine = config.binary + " " + config.args.map(a => sq(a)).join(" ");
  const windowName = config.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);

  if (config.interactive) {
    writeFileSync(scriptFile, [
      `#!/usr/bin/env bash`,
      `cd ${sq(config.cwd)}`,
      cmdLine,
      `echo $? > ${sq(exitFile)}`,
      `tmux wait-for -S ${sq(signal)}`,
    ].join("\n"), { mode: 0o755 });

    if (config.logFile) {
      mkdirSync(dirname(config.logFile), { recursive: true });
    }

    // New window (not split) — keeps TUI intact
    const paneId = execSync(
      `tmux new-window -d -n ${sq(windowName)} -P -F '#{pane_id}' ${sq(scriptFile)}`,
      { cwd: config.cwd, encoding: "utf-8" },
    ).trim();

    if (config.logFile) {
      try {
        execSync(`tmux pipe-pane -o -t ${sq(paneId)} ${sq(`cat >> ${config.logFile}`)}`, { stdio: "ignore" });
      } catch {}
    }

    const done = waitForSignal(signal, exitFile, paneId, config.signal);
    return {
      jsonStream: null,
      paneId,
      done,
      cleanup: () => { safeUnlink(exitFile); safeUnlink(scriptFile); },
    };
  }

  // Headless-in-tmux: new window with FIFO for JSON parsing
  execSync(`mkfifo ${sq(fifoPath)}`);

  writeFileSync(scriptFile, [
    `#!/usr/bin/env bash`,
    `cd ${sq(config.cwd)}`,
    `${cmdLine} | tee ${sq(fifoPath)}`,
    `echo \${PIPESTATUS[0]} > ${sq(exitFile)}`,
    `tmux wait-for -S ${sq(signal)}`,
  ].join("\n"), { mode: 0o755 });

  const paneId = execSync(
    `tmux new-window -d -n ${sq(windowName)} -P -F '#{pane_id}' ${sq(scriptFile)}`,
    { cwd: config.cwd, encoding: "utf-8" },
  ).trim();

  const jsonStream = createReadStream(fifoPath, { encoding: "utf-8" });
  const done = waitForSignal(signal, exitFile, paneId, config.signal);

  return {
    jsonStream,
    paneId,
    done,
    cleanup: () => { safeUnlink(fifoPath); safeUnlink(exitFile); safeUnlink(scriptFile); },
  };
}

function waitForSignal(
  signal: string,
  exitFile: string,
  paneId: string,
  abort?: AbortSignal,
  timeoutMs = 600000,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", ["wait-for", signal], { stdio: "ignore" });
    let settled = false;

    function finish(exitCode: number) {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      clearTimeout(timer);
      resolve({ exitCode });
    }

    // Timeout: if agent doesn't finish in timeoutMs, kill it
    const timer = setTimeout(() => {
      killPane(paneId);
      finish(124); // 124 = timeout (same as GNU timeout)
    }, timeoutMs);

    const onAbort = () => {
      killPane(paneId);
      finish(130);
    };
    abort?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", () => {
      abort?.removeEventListener("abort", onAbort);
      let exitCode = 1;
      try { exitCode = parseInt(readFileSync(exitFile, "utf-8").trim(), 10) || 1; } catch {}
      finish(exitCode);
    });
  });
}
