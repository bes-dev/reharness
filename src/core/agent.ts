import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Readable } from "stream";
import { hasTmux, spawnInTmux } from "./tmux.js";

export interface AgentRunConfig {
  prompt: string;
  task: string;
  cwd: string;
  logFile?: string;
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  piBinary?: string;
  piModel?: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  exitCode: number;
  model?: string;
  tokensIn: number;
  tokensOut: number;
}

interface ParseCallbacks {
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  logFile?: string;
}

/**
 * Parse Pi's JSON event stream from any readable stream.
 * Reused for both direct subprocess stdout and tmux FIFO.
 */
export function parseJsonEventStream(stream: Readable, cb: ParseCallbacks): Promise<{ model?: string; tokensIn: number; tokensOut: number }> {
  return new Promise((resolve) => {
    let model: string | undefined;
    let tokensIn = 0;
    let tokensOut = 0;
    let buf = "";

    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const e = JSON.parse(raw);

          if (e.type === "tool_execution_start" && e.toolName) {
            const detail = e.args?.path || e.args?.command?.slice(0, 60) || "";
            cb.onLine?.(`  ⏳ ${e.toolName}${detail ? " " + detail : ""}`);
            if (cb.logFile) appendFileSync(cb.logFile, `[tool] ${e.toolName} ${detail}\n`);
          } else if (e.type === "tool_execution_end" && e.toolName) {
            cb.onLine?.(`  ✓ ${e.toolName}`);
          }

          if (e.type === "message_end" && e.message?.role === "assistant") {
            if (e.message.model) model = e.message.model;
            if (e.message.usage) {
              tokensIn += e.message.usage.input || 0;
              tokensOut += e.message.usage.output || 0;
              const total = tokensIn + tokensOut;
              const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
              const label = model || "agent";
              cb.onStatus?.(`${label} · ${totalK} tokens`);
            }

            for (const c of e.message.content || []) {
              if (c.type === "thinking" && c.thinking && cb.logFile) {
                appendFileSync(cb.logFile, `[thinking] ${c.thinking}\n\n`);
              }
              if (c.type === "text" && c.text && cb.logFile) {
                appendFileSync(cb.logFile, `[response] ${c.text}\n\n`);
              }
            }
          }

          if (e.type === "tool_execution_end" && e.isError && cb.logFile) {
            const errText = e.result?.content?.[0]?.text || "";
            if (errText) appendFileSync(cb.logFile, `[error] ${e.toolName}: ${errText.slice(0, 500)}\n\n`);
          }
        } catch {}
      }
    });

    stream.on("end", () => resolve({ model, tokensIn, tokensOut }));
    stream.on("error", () => resolve({ model, tokensIn, tokensOut }));
  });
}

/**
 * Run a Pi agent as a subprocess.
 * Uses tmux pane when available (visible output), falls back to headless.
 */
export async function runAgentProcess(config: AgentRunConfig): Promise<AgentRunResult> {
  const binary = config.piBinary || "pi";

  if (config.signal?.aborted) {
    return { exitCode: 130, tokensIn: 0, tokensOut: 0 };
  }

  if (config.logFile) {
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(config.logFile, `# Agent: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`);
  }

  const piArgs = ["--mode", "json", "-p", "--no-session"];
  if (config.piModel) piArgs.push("--model", config.piModel);
  piArgs.push("--system-prompt", config.prompt, config.task);

  if (hasTmux()) {
    return runViaTmux(binary, piArgs, config);
  }
  return runHeadless(binary, piArgs, config);
}

async function runViaTmux(binary: string, piArgs: string[], config: AgentRunConfig): Promise<AgentRunResult> {
  const handle = spawnInTmux({
    binary, args: piArgs, cwd: config.cwd,
    sessionLabel: config.prompt, signal: config.signal,
  });

  const parsed = handle.jsonStream
    ? await parseJsonEventStream(handle.jsonStream, config)
    : { model: undefined, tokensIn: 0, tokensOut: 0 };

  const { exitCode } = await handle.done;
  handle.cleanup();

  if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${exitCode}\n`);
  if (exitCode !== 0) {
    config.onLine?.(`  exit code ${exitCode}`);
  }

  return { exitCode, ...parsed };
}

function runHeadless(binary: string, piArgs: string[], config: AgentRunConfig): Promise<AgentRunResult> {
  return new Promise((res, rej) => {
    const proc = spawn(binary, piArgs, {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const onAbort = () => {
      if (config.logFile) appendFileSync(config.logFile!, `\n[aborted]\n`);
      proc.kill("SIGTERM");
    };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    const parsed = parseJsonEventStream(proc.stdout, config);

    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (config.logFile) appendFileSync(config.logFile!, `[stderr] ${text}`);
    });

    proc.on("close", async (code) => {
      config.signal?.removeEventListener("abort", onAbort);
      const { model, tokensIn, tokensOut } = await parsed;
      if (config.logFile) appendFileSync(config.logFile!, `\n[exit] code=${code ?? 1}\n`);
      if (code !== 0 && stderrBuf.trim()) {
        stderrBuf.trim().split("\n").slice(-3).forEach((line) => {
          config.onLine?.(`  ${line}`);
        });
      }
      res({ exitCode: code ?? 1, model, tokensIn, tokensOut });
    });
    proc.on("error", rej);
  });
}

/**
 * Run an interactive Pi session in a tmux pane.
 * User can interact with the agent directly. Requires tmux.
 */
export async function runInteractiveProcess(config: AgentRunConfig): Promise<void> {
  if (!hasTmux()) {
    throw new Error("ctx.interactive() requires tmux. Run reharness inside a tmux session.");
  }

  const binary = config.piBinary || "pi";

  if (config.logFile) {
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(config.logFile, `# Interactive: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`);
  }

  const handle = spawnInTmux({
    binary,
    args: [...(config.piModel ? ["--model", config.piModel] : []), "--system-prompt", config.prompt, config.task],
    cwd: config.cwd,
    sessionLabel: config.prompt,
    logFile: config.logFile,
    interactive: true,
    signal: config.signal,
  });

  const { exitCode } = await handle.done;
  handle.cleanup();

  if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${exitCode}\n`);
  if (exitCode !== 0) {
    throw new Error(`Interactive session failed (exit ${exitCode})`);
  }
}
