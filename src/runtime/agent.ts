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
  /** Deterministic in-session validator: returns error strings (empty = ok). On failure the SAME live
   *  session is re-prompted with the errors so the agent self-corrects in-context. Triggers RPC mode. */
  validate?: () => string[] | Promise<string[]>;
  /** Absolute path to a file appended to the system prompt (Pi `--append-system-prompt`). */
  appendPrompt?: string;
}

interface ParseCallbacks {
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  logFile?: string;
}

interface TokenState { model?: string; tokensIn: number; tokensOut: number; }

/** Log/emit a single Pi agent event (tool calls, assistant messages, token usage). Shared by the
 *  one-shot JSON stream and the RPC driver so both surface identical progress/logs. */
function logAgentEvent(e: any, cb: ParseCallbacks, ts: TokenState): void {
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
    if (e.message.model) ts.model = e.message.model;
    if (e.message.usage) {
      ts.tokensIn += e.message.usage.input || 0;
      ts.tokensOut += e.message.usage.output || 0;
      const total = ts.tokensIn + ts.tokensOut;
      const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
      cb.onStatus?.(`${ts.model || "agent"} · ${totalK} tokens`);
    }
    if (cb.logFile) {
      for (const c of e.message.content || []) {
        if (c.type === "thinking" && c.thinking) appendFileSync(cb.logFile, `[thinking] ${c.thinking}\n\n`);
        if (c.type === "text" && c.text) appendFileSync(cb.logFile, `[response] ${c.text}\n\n`);
      }
    }
  }
}

function parseJsonEventStream(stream: Readable, cb: ParseCallbacks): Promise<void> {
  return new Promise((res) => {
    const ts: TokenState = { tokensIn: 0, tokensOut: 0 };
    let buf = "";
    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let e: any;
        try { e = JSON.parse(raw); } catch { continue; }
        logAgentEvent(e, cb, ts);
      }
    });
    stream.on("end", () => res());
    stream.on("error", () => res());
  });
}

/** Spawn a Pi agent. With a validator → live RPC session with in-session re-prompting; otherwise one-shot. */
export async function runAgent(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  if (config.logFile) {
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(config.logFile, `# Agent: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`);
  }

  if (config.validate) return runAgentRpc(config);

  const args = ["--mode", "json", "-p", "--no-session"];
  if (config.piModel) args.push("--model", config.piModel);
  args.push("--system-prompt", config.prompt);
  if (config.appendPrompt) args.push("--append-system-prompt", config.appendPrompt);
  args.push(config.task);

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
 * In-session validation via Pi's RPC mode. reharness drives ONE live session:
 *   prompt(task) → wait `agent_end` → run the deterministic validator → on failure, send another
 *   `prompt` with the concrete errors into the SAME live session → repeat until clean or maxAttempts.
 *
 * The orchestrator (not the agent) decides completion — mechanical. The process stays alive across
 * re-prompts, so the prompt cache stays hot and the agent fixes its OWN output in-context (no fresh
 * patch session, no context rebuild). Continuation is a repeated `prompt` (verified: `follow_up` only
 * queues and does NOT reactivate an idle agent).
 *
 * The validator is the caller-supplied `validate()` closure (e.g. validateSkeleton for the design agent),
 * returning error strings (empty = clean).
 */
async function runAgentRpc(config: AgentRunConfig): Promise<void> {
  const args = ["--mode", "rpc", "--no-session"];
  if (config.piModel) args.push("--model", config.piModel);
  args.push("--system-prompt", config.prompt);
  if (config.appendPrompt) args.push("--append-system-prompt", config.appendPrompt);

  const proc = spawn(config.piBinary || "pi", args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const ts: TokenState = { tokensIn: 0, tokensOut: 0 };
  let buf = "";
  let onTurnEnd: (() => void) | null = null;

  proc.stdout.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let e: any;
      try { e = JSON.parse(raw); } catch { continue; }
      // Skip RPC command acks, extension-UI requests, and queue notices (headless: no UI extensions).
      if (e.type === "response" || e.type === "extension_ui_request" || e.type === "extension_error" || e.type === "queue_update") continue;
      logAgentEvent(e, config, ts);
      if (e.type === "agent_end") { const r = onTurnEnd; onTurnEnd = null; r?.(); }
    }
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBuf += text;
    if (config.logFile) appendFileSync(config.logFile, `[stderr] ${text}`);
  });

  let aborted = false;
  let exited = false;
  const onAbort = () => { aborted = true; if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`); proc.kill("SIGTERM"); };
  config.signal?.addEventListener("abort", onAbort, { once: true });

  // On process close, resolve any in-flight turn so `await turn` never hangs if Pi dies mid-session
  // (stdout closes without an `agent_end`). This also covers abort: onAbort kills the proc → close fires
  // → the turn resolves, so no per-turn signal listener is needed (which previously leaked one per turn).
  const closed = new Promise<number>((res) => proc.on("close", (code) => {
    exited = true;
    const r = onTurnEnd; onTurnEnd = null; r?.();
    res(code ?? 1);
  }));
  const send = (cmd: object) => { if (!proc.killed) proc.stdin.write(JSON.stringify(cmd) + "\n"); };
  const nextTurn = () => new Promise<void>((res) => { onTurnEnd = res; });
  const awaitTurn = async (t: Promise<void>): Promise<void> => {
    await t;
    if (aborted) throw new Error("Aborted");
    if (exited) throw new Error("Pi process exited before completing the turn");
  };

  const runValidate = async (): Promise<string[]> => (config.validate ? await config.validate() : []);
  const maxAttempts = 3;

  try {
    let turn = nextTurn();
    send({ type: "prompt", message: config.task });
    await awaitTurn(turn);

    let errs = await runValidate();
    let attempts = 0;
    while (errs.length && attempts < maxAttempts) {
      config.onLine?.(`  ⚠ validation: ${errs[0]} — re-prompting (${attempts + 1}/${maxAttempts})`);
      if (config.logFile) appendFileSync(config.logFile, `[validate] FAIL:\n- ${errs.join("\n- ")}\n`);
      turn = nextTurn();
      send({ type: "prompt", message: `Your output failed validation:\n- ${errs.join("\n- ")}\n\nFix this now and finish — edit only what's needed to resolve the above.` });
      await awaitTurn(turn);
      errs = await runValidate();
      attempts++;
    }

    if (errs.length) {
      if (config.logFile) appendFileSync(config.logFile, `[validate] GIVE UP after ${attempts} attempt(s):\n- ${errs.join("\n- ")}\n`);
      throw new Error(`Validation not satisfied after ${attempts} attempt(s): ${errs.join("; ")}`);
    }
    if (attempts > 0) config.onLine?.(`  ✓ validation passed (${attempts} fix round(s))`);
    if (config.logFile) appendFileSync(config.logFile, `[validate] OK\n`);
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
    try { proc.stdin.end(); } catch { /* already closed */ }
    proc.kill("SIGTERM"); // RPC mode is a long-lived server — terminate explicitly
    await closed;
    if (config.logFile) appendFileSync(config.logFile, `\n[exit]\n`);
    if (stderrBuf.trim() && config.onLine) stderrBuf.trim().split("\n").slice(-3).forEach((l) => config.onLine?.(`  ${l}`));
  }
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
  if (config.appendPrompt) args.push("--append-system-prompt", config.appendPrompt);
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
