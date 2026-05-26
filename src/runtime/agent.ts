import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { Readable } from "stream";

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

interface ParseCallbacks {
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  logFile?: string;
}

function parseJsonEventStream(stream: Readable, cb: ParseCallbacks): Promise<void> {
  return new Promise((res) => {
    let model: string | undefined;
    let tokensIn = 0, tokensOut = 0;
    let buf = "";

    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const raw of lines) {
        if (!raw.trim()) continue;
        let e: any;
        try { e = JSON.parse(raw); } catch { continue; }

        if (e.type === "tool_execution_start" && e.toolName) {
          const detail = e.args?.path || e.args?.command?.slice(0, 60) || "";
          cb.onLine?.(`  ⏳ ${e.toolName}${detail ? " " + detail : ""}`);
          if (cb.logFile) appendFileSync(cb.logFile, `[tool] ${e.toolName} ${detail}\n`);
        } else if (e.type === "tool_execution_end" && e.toolName) {
          cb.onLine?.(`  ✓ ${e.toolName}`);
          if (e.isError && cb.logFile) {
            const errText = e.result?.content?.[0]?.text || "";
            if (errText) appendFileSync(cb.logFile, `[error] ${e.toolName}: ${errText.slice(0, 500)}\n\n`);
          }
        }

        if (e.type === "message_end" && e.message?.role === "assistant") {
          if (e.message.model) model = e.message.model;
          if (e.message.usage) {
            tokensIn += e.message.usage.input || 0;
            tokensOut += e.message.usage.output || 0;
            const total = tokensIn + tokensOut;
            const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
            cb.onStatus?.(`${model || "agent"} · ${totalK} tokens`);
          }
          if (cb.logFile) {
            for (const c of e.message.content || []) {
              if (c.type === "thinking" && c.thinking) appendFileSync(cb.logFile, `[thinking] ${c.thinking}\n\n`);
              if (c.type === "text" && c.text) appendFileSync(cb.logFile, `[response] ${c.text}\n\n`);
            }
          }
        }
      }
    });

    stream.on("end", () => res());
    stream.on("error", () => res());
  });
}

/** Spawn a Pi agent subprocess. Throws on non-zero exit. */
export async function runAgent(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  if (config.logFile) {
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(config.logFile, `# Agent: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`);
  }

  const args = ["--mode", "json", "-p", "--no-session"];
  if (config.piModel) args.push("--model", config.piModel);
  args.push("--system-prompt", config.prompt, config.task);

  const exitCode: number = await new Promise((res, rej) => {
    const proc = spawn(config.piBinary || "pi", args, {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const onAbort = () => {
      if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`);
      proc.kill("SIGTERM");
    };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    const parsed = parseJsonEventStream(proc.stdout, config);
    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (config.logFile) appendFileSync(config.logFile, `[stderr] ${text}`);
    });

    proc.on("close", async (code) => {
      config.signal?.removeEventListener("abort", onAbort);
      await parsed;
      if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${code ?? 1}\n`);
      if (code !== 0 && stderrBuf.trim()) {
        stderrBuf.trim().split("\n").slice(-3).forEach((line) => config.onLine?.(`  ${line}`));
      }
      res(code ?? 1);
    });
    proc.on("error", rej);
  });

  if (config.signal?.aborted) throw new Error("Aborted");
  if (exitCode !== 0) throw new Error(`Agent failed (exit ${exitCode})`);
}

/**
 * Spawn a Pi agent with stdio inherited from the parent process — a free-chat session.
 * Returns when the user exits Pi (Ctrl+D / /quit). Throws on non-zero exit.
 */
export async function runInteractive(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  const args: string[] = ["--no-session"];
  if (config.piModel) args.push("--model", config.piModel);
  args.push("--system-prompt", config.prompt);
  if (config.task) args.push(config.task);

  const exitCode: number = await new Promise((res, rej) => {
    const proc = spawn(config.piBinary || "pi", args, {
      cwd: config.cwd,
      stdio: "inherit",
      env: process.env,
    });
    const onAbort = () => proc.kill("SIGTERM");
    config.signal?.addEventListener("abort", onAbort, { once: true });
    proc.on("close", (code) => {
      config.signal?.removeEventListener("abort", onAbort);
      res(code ?? 1);
    });
    proc.on("error", rej);
  });

  if (config.signal?.aborted) throw new Error("Aborted");
  if (exitCode !== 0) throw new Error(`Interactive session exited with code ${exitCode}`);
}

