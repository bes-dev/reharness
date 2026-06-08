import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { Readable } from "stream";
import { piProvider, type Provider, type NormEvent } from "./providers.js";
import { redact } from "./redact.js";
import { AGENT_RETRIES, AGENT_BACKOFF_MS } from "../config.js";

/** Map a raw spawn failure to an actionable message — a missing backend binary is the #1 first-run stumble. */
function spawnError(provider: Provider, binary: string, e: any): Error {
  if (e?.code === "ENOENT")
    return new Error(`Backend '${provider.name}' not found: '${binary}' is not on PATH. Install it (pi: \`npm i -g @mariozechner/pi-coding-agent\`; claude: the Claude Code CLI) or pass an absolute path via --model/def.piBinary.`);
  return e instanceof Error ? e : new Error(String(e));
}

/** A non-zero exit whose stderr looks like a momentary backend hiccup (rate-limit / 5xx / dropped connection) —
 *  worth a backoff-and-retry. A deterministic content error (bad request, auth) is NOT transient: fail fast. */
function isTransient(stderr: string): boolean {
  return /\b(429|5\d\d|rate[ _-]?limit|overloaded|too many requests|timed?[ _-]?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|service unavailable)\b/i.test(stderr);
}

/** Exponential backoff with ±50% jitter (jitter de-correlates concurrent fan-out retries). */
function backoffMs(attempt: number): number {
  return Math.round(AGENT_BACKOFF_MS * 2 ** attempt * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("Aborted")); }, { once: true });
  });
}

export interface AgentRunConfig {
  prompt: string;
  task: string;
  cwd: string;
  logFile?: string;
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  /** Override the provider's default executable (e.g. an absolute `pi`/`claude` path). */
  piBinary?: string;
  piModel?: string;
  /** Backend adapter (Pi / Claude Code). Absent ⇒ Pi — so direct callers and tests are unchanged. */
  provider?: Provider;
  signal?: AbortSignal;
  /** Deterministic in-session validator: returns error strings (empty = ok). On failure the SAME live
   *  session is re-prompted with the errors so the agent self-corrects in-context. Triggers RPC mode. */
  validate?: () => string[] | Promise<string[]>;
  /** Absolute path to a file appended to the system prompt. */
  appendPrompt?: string;
  /** Per-leaf harness (the three static axes; absent ⇒ provider defaults, identical to pre-harness spawn).
   *  `model` is `piModel` above. See docs/design and [[tool-synthesis]] memory. */
  skills?: string[];      // knowledge/instructions injected for this leaf
  extensions?: string[];  // bound external capability, e.g. web tools
  /** Called once the agent finishes with its total LLM spend (summed from usage events) — the runtime
   *  aggregates these into the run's cost. A code state never calls this, so a 0-agent pipeline records $0. */
  onUsage?: (u: AgentUsage) => void;
}

/** Per-agent LLM spend, summed from the backend's usage events. */
export interface AgentUsage { costUSD: number; tokensIn: number; tokensOut: number; model?: string; }

interface ParseCallbacks {
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  logFile?: string;
}

interface TokenState { model?: string; tokensIn: number; tokensOut: number; costUSD: number; }

/** Apply one normalized event (logging, progress, usage accounting). Backend-agnostic — each Provider maps its own
 *  stream onto NormEvent, so this is shared by the one-shot stream and the RPC driver and stays identical for both. */
function applyEvent(n: NormEvent, cb: ParseCallbacks, ts: TokenState): void {
  switch (n.kind) {
    case "tool_start":
      cb.onLine?.(redact(`  ⏳ ${n.name}${n.detail ? " " + n.detail : ""}`));
      if (cb.logFile) appendFileSync(cb.logFile, redact(`[tool] ${n.name} ${n.detail ?? ""}\n`));
      break;
    case "tool_end":
      cb.onLine?.(`  ✓ ${n.name}`);
      if (n.error && cb.logFile) appendFileSync(cb.logFile, redact(`[error] ${n.name}: ${n.error.slice(0, 500)}\n\n`));
      break;
    case "thinking":
      if (cb.logFile) appendFileSync(cb.logFile, redact(`[thinking] ${n.text}\n\n`));
      break;
    case "text":
      if (cb.logFile) appendFileSync(cb.logFile, redact(`[response] ${n.text}\n\n`));
      break;
    case "usage": {
      if (n.model) ts.model = n.model;
      ts.tokensIn += n.tokensIn; ts.tokensOut += n.tokensOut;
      ts.costUSD = n.costCumulative ? n.costUSD : ts.costUSD + n.costUSD; // cumulative total ⇒ set, not add
      const total = ts.tokensIn + ts.tokensOut;
      const totalK = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
      cb.onStatus?.(`${ts.model || "agent"} · ${totalK} tokens`);
      break;
    }
    case "turn_end": break; // the RPC driver watches for this; one-shot reads to EOF
  }
}

function parseJsonEventStream(stream: Readable, provider: Provider, cb: ParseCallbacks, ts: TokenState): Promise<void> {
  return new Promise((res) => {
    let buf = "";
    stream.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let e: any;
        try { e = JSON.parse(raw); } catch { continue; }
        for (const n of provider.normalize(e)) applyEvent(n, cb, ts);
      }
    });
    stream.on("end", () => res());
    stream.on("error", () => res());
  });
}

/** Spawn an agent. With a validator → live RPC session with in-session re-prompting; otherwise one-shot (with a
 *  bounded transient-failure retry: a rate-limit / 5xx / dropped connection backs off and retries, while a content
 *  error fails fast — and once the budget is spent the leaf fails loud, so the FSM's fail-loud invariant holds). */
export async function runAgent(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  if (config.logFile) {
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(config.logFile, redact(`# Agent: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`));
  }

  if (config.validate) return runAgentRpc(config);

  const provider = config.provider || piProvider;
  const binary = config.piBinary || provider.binary;
  const args = provider.args("oneshot", config);

  // Cost is accumulated ACROSS attempts (each spawn is a fresh session, so a per-attempt total is summed) and
  // reported once — a retried leaf still records its full spend, and exactly one agent-run.
  const total: AgentUsage = { costUSD: 0, tokensIn: 0, tokensOut: 0 };
  let lastCode = 1, lastStderr = "";
  try {
    for (let attempt = 0; ; attempt++) {
      const ts: TokenState = { tokensIn: 0, tokensOut: 0, costUSD: 0 };
      const { code, stderr } = await oneshotAttempt(config, provider, binary, args, ts);
      total.costUSD += ts.costUSD; total.tokensIn += ts.tokensIn; total.tokensOut += ts.tokensOut; total.model = ts.model || total.model;
      lastCode = code; lastStderr = stderr;
      if (config.signal?.aborted) throw new Error("Aborted");
      if (code === 0) return;
      if (attempt >= AGENT_RETRIES || !isTransient(stderr)) break;
      const delay = backoffMs(attempt);
      config.onLine?.(`  ⚠ transient backend failure (exit ${code}); retrying ${attempt + 1}/${AGENT_RETRIES} in ${(delay / 1000).toFixed(1)}s`);
      if (config.logFile) appendFileSync(config.logFile, `\n[retry ${attempt + 1}/${AGENT_RETRIES}] after exit ${code}\n`);
      await sleep(delay, config.signal);
    }
    if (lastStderr.trim()) lastStderr.trim().split("\n").slice(-3).forEach((line) => config.onLine?.(redact(`  ${line}`)));
    throw new Error(`Agent failed (exit ${lastCode})`);
  } finally {
    config.onUsage?.(total);
  }
}

/** One one-shot spawn. Resolves with the exit code + collected stderr (never rejects on a non-zero exit — the
 *  caller decides retry-or-fail); rejects only on a spawn-level error (e.g. binary not found, mapped to a clear msg). */
function oneshotAttempt(config: AgentRunConfig, provider: Provider, binary: string, args: string[], ts: TokenState): Promise<{ code: number; stderr: string }> {
  return new Promise((res, rej) => {
    const proc = spawn(binary, args, { cwd: config.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const onAbort = () => { if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`); proc.kill("SIGTERM"); };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    const parsed = parseJsonEventStream(proc.stdout, provider, config, ts);
    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (config.logFile) appendFileSync(config.logFile, redact(`[stderr] ${text}`));
    });

    proc.on("close", async (code) => {
      config.signal?.removeEventListener("abort", onAbort);
      await parsed;
      if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${code ?? 1}\n`);
      res({ code: code ?? 1, stderr: stderrBuf });
    });
    proc.on("error", (e) => { config.signal?.removeEventListener("abort", onAbort); rej(spawnError(provider, binary, e)); });
  });
}

/**
 * In-session validation via the backend's RPC/streaming mode. reharness drives ONE live session:
 *   prompt(task) → wait for the turn-end event → run the deterministic validator → on failure, send another
 *   prompt with the concrete errors INTO THE SAME live session → repeat until clean or maxAttempts.
 *
 * The orchestrator (not the agent) decides completion — mechanical. The process stays alive across
 * re-prompts, so the prompt cache stays hot and the agent fixes its OWN output in-context (no fresh
 * patch session, no context rebuild). A turn is one framed user message; turn-end is the provider's
 * `turn_end` NormEvent (Pi `agent_end` / Claude `result`).
 *
 * The validator is the caller-supplied `validate()` closure (e.g. validateSkeleton for the design agent),
 * returning error strings (empty = clean).
 */
async function runAgentRpc(config: AgentRunConfig): Promise<void> {
  const provider = config.provider || piProvider;
  const binary = config.piBinary || provider.binary;
  const args = provider.args("rpc", config);

  const proc = spawn(binary, args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const ts: TokenState = { tokensIn: 0, tokensOut: 0, costUSD: 0 };
  let buf = "";
  let onTurnEnd: (() => void) | null = null;
  // A spawn-level failure (e.g. missing binary) emits 'error' AND 'close'; without a handler Node throws unhandled.
  // Capture it (mapped to a clear message) and release any pending turn so the awaits below surface it, not a hang.
  let spawnErr: Error | null = null;
  proc.on("error", (e) => { spawnErr = spawnError(provider, binary, e); const r = onTurnEnd; onTurnEnd = null; r?.(); });

  proc.stdout.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let e: any;
      try { e = JSON.parse(raw); } catch { continue; }
      for (const n of provider.normalize(e)) {
        applyEvent(n, config, ts);
        if (n.kind === "turn_end") { const r = onTurnEnd; onTurnEnd = null; r?.(); }
      }
    }
  });

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBuf += text;
    if (config.logFile) appendFileSync(config.logFile, redact(`[stderr] ${text}`));
  });

  let aborted = false;
  let exited = false;
  const onAbort = () => { aborted = true; if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`); proc.kill("SIGTERM"); };
  config.signal?.addEventListener("abort", onAbort, { once: true });

  // On process close, resolve any in-flight turn so `await turn` never hangs if the backend dies mid-session
  // (stdout closes without a turn-end). This also covers abort: onAbort kills the proc → close fires → the turn
  // resolves, so no per-turn signal listener is needed (which previously leaked one per turn).
  const closed = new Promise<number>((res) => proc.on("close", (code) => {
    exited = true;
    const r = onTurnEnd; onTurnEnd = null; r?.();
    res(code ?? 1);
  }));
  const send = (cmd: object) => { if (!proc.killed) proc.stdin.write(JSON.stringify(cmd) + "\n"); };
  const nextTurn = () => new Promise<void>((res) => { onTurnEnd = res; });
  const awaitTurn = async (t: Promise<void>): Promise<void> => {
    await t;
    if (spawnErr) throw spawnErr;   // a clear "binary not found" beats a generic "exited before completing"
    if (aborted) throw new Error("Aborted");
    if (exited) throw new Error("Agent process exited before completing the turn");
  };

  const runValidate = async (): Promise<string[]> => (config.validate ? await config.validate() : []);
  const maxAttempts = 3;

  try {
    let turn = nextTurn();
    send(provider.frame(config.task));
    await awaitTurn(turn);

    let errs = await runValidate();
    let attempts = 0;
    while (errs.length && attempts < maxAttempts) {
      config.onLine?.(`  ⚠ validation: ${errs[0]} — re-prompting (${attempts + 1}/${maxAttempts})`);
      if (config.logFile) appendFileSync(config.logFile, `[validate] FAIL:\n- ${errs.join("\n- ")}\n`);
      turn = nextTurn();
      send(provider.frame(`Your output failed validation:\n- ${errs.join("\n- ")}\n\nFix this now and finish — edit only what's needed to resolve the above.`));
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
    config.onUsage?.({ costUSD: ts.costUSD, tokensIn: ts.tokensIn, tokensOut: ts.tokensOut, model: ts.model });
    if (config.logFile) appendFileSync(config.logFile, `\n[exit]\n`);
    if (stderrBuf.trim() && config.onLine) stderrBuf.trim().split("\n").slice(-3).forEach((l) => config.onLine?.(redact(`  ${l}`)));
  }
}

/**
 * Spawn an agent with stdio inherited from the parent process — a free-chat session.
 * Returns when the user exits the backend (Ctrl+D / /quit). Throws on non-zero exit.
 */
export async function runInteractive(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  const provider = config.provider || piProvider;
  const binary = config.piBinary || provider.binary;
  const args = provider.args("interactive", config);

  const exitCode: number = await new Promise((res, rej) => {
    const proc = spawn(binary, args, {
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
    proc.on("error", (e) => rej(spawnError(provider, binary, e)));
  });

  if (config.signal?.aborted) throw new Error("Aborted");
  if (exitCode !== 0) throw new Error(`Interactive session exited with code ${exitCode}`);
}
