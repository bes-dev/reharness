import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface AgentRunConfig {
  prompt: string;
  task: string;
  cwd: string;
  logFile?: string;
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  piBinary?: string;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  output: string;
  exitCode: number;
  model?: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Run a Pi agent as a subprocess.
 * Spawns `pi --mode json -p --no-session --system-prompt <prompt> <task>`.
 * Parses JSON event stream, logs reasoning, streams tool events.
 */
export function runAgentProcess(config: AgentRunConfig): Promise<AgentRunResult> {
  const binary = config.piBinary || "pi";

  return new Promise((res, rej) => {
    if (config.signal?.aborted) {
      res({ output: "", exitCode: 130, tokensIn: 0, tokensOut: 0 });
      return;
    }

    if (config.logFile) {
      mkdirSync(dirname(config.logFile), { recursive: true });
      writeFileSync(config.logFile, `# Agent: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`);
    }

    const proc = spawn(binary, [
      "--mode", "json", "-p", "--no-session",
      "--system-prompt", config.prompt,
      config.task,
    ], {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const onAbort = () => {
      if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`);
      proc.kill("SIGTERM");
    };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    let output = "";
    let model: string | undefined;
    let tokensIn = 0;
    let tokensOut = 0;
    let buf = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const raw of lines) {
        if (!raw.trim()) continue;
        try {
          const e = JSON.parse(raw);

          if (e.type === "tool_execution_start" && e.toolName) {
            const detail = e.args?.path || e.args?.command?.slice(0, 60) || "";
            config.onLine?.(`  ⏳ ${e.toolName}${detail ? " " + detail : ""}`);
            if (config.logFile) appendFileSync(config.logFile, `[tool] ${e.toolName} ${detail}\n`);
          } else if (e.type === "tool_execution_end" && e.toolName) {
            config.onLine?.(`  ✓ ${e.toolName}`);
          }

          if (e.type === "message_end" && e.message?.role === "assistant") {
            // Extract model and usage
            if (e.message.model) model = e.message.model;
            if (e.message.usage) {
              tokensIn += e.message.usage.input || 0;
              tokensOut += e.message.usage.output || 0;
              const total = tokensIn + tokensOut;
              const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
              const label = model || "agent";
              config.onStatus?.(`${label} · ${totalK} tokens`);
            }

            for (const c of e.message.content || []) {
              if (c.type === "thinking" && c.thinking && config.logFile) {
                appendFileSync(config.logFile, `[thinking] ${c.thinking}\n\n`);
              }
              if (c.type === "text" && c.text) {
                output = c.text;
                if (config.logFile) appendFileSync(config.logFile, `[response] ${c.text}\n\n`);
              }
            }
          }

          if (e.type === "tool_execution_end" && e.isError && config.logFile) {
            const errText = e.result?.content?.[0]?.text || "";
            if (errText) appendFileSync(config.logFile, `[error] ${e.toolName}: ${errText.slice(0, 500)}\n\n`);
          }
        } catch {}
      }
    });

    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (config.logFile) appendFileSync(config.logFile!, `[stderr] ${text}`);
    });

    proc.on("close", (code) => {
      config.signal?.removeEventListener("abort", onAbort);
      if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${code ?? 1}\n`);
      if (code !== 0 && stderrBuf.trim()) {
        stderrBuf.trim().split("\n").slice(-3).forEach((line) => {
          config.onLine?.(`  ${line}`);
        });
      }
      res({ output, exitCode: code ?? 1, model, tokensIn, tokensOut });
    });
    proc.on("error", rej);
  });
}
