import { spawn } from "child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Readable } from "stream";
import { piProvider, type Provider, type NormEvent, type PromptInput } from "./providers.js";
import { redact } from "./redact.js";
import { AGENT_RETRIES, AGENT_BACKOFF_MS } from "../config.js";

/** Map a raw spawn failure to an actionable message — a missing backend binary is the #1 first-run stumble. */
function spawnError(provider: Provider, binary: string, e: any): Error {
  if (e?.code === "ENOENT")
    return new Error(`Backend '${provider.name}' not found: '${binary}' is not on PATH.${provider.installHint ? ` Install it: ${provider.installHint}.` : ""} Or pass an absolute path via --binary/def.binary.`);
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
  /** Override the provider's default executable. Precedence: `binary ?? piBinary` (`piBinary` is the legacy
   *  Pi-era name, kept as an accepted alias). */
  binary?: string;
  piBinary?: string;
  /** Backend-native model id (e.g. "anthropic/claude-sonnet-4-6"). Precedence: `model ?? piModel` (`piModel`
   *  is the legacy Pi-era name, kept as an accepted alias). */
  model?: string;
  piModel?: string;
  /** Backend adapter. Absent ⇒ Pi — so direct callers and tests are unchanged. */
  provider?: Provider;
  /** Per-leaf scratch dir the driver created for providers that need one (`Provider.prepare`); set by runAgent. */
  providerScratchDir?: string;
  signal?: AbortSignal;
  /** Per-leaf watchdog (the two-timer model). Each 0/undefined = disabled. idleMs = L1 liveness (kill on silence);
   *  maxMs/maxUsd/maxTokens = L3 hard ceilings (non-extendable, span retries). A breach kills the leaf and fails
   *  loud — never a retry. Resolved from config defaults + `--param` by the runtime; direct callers can set them. */
  idleMs?: number;
  maxMs?: number;
  maxUsd?: number;
  maxTokens?: number;
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
export interface AgentUsage { costUSD: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; model?: string; }

interface ParseCallbacks {
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  logFile?: string;
  /** Watchdog heartbeat: called on every stream chunk so the idle timer treats any backend output as "alive". */
  onBeat?: () => void;
  /** The leaf's run config, handed to provider.normalize (a provider may stash per-run artifacts, e.g. opencode's rpc session id). */
  runConfig?: AgentRunConfig;
}

interface TokenState { model?: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; costUSD: number; }

/** Resolve the backend's executable + the system-prompt input. `config.prompt` is a file PATH; content is read
 *  lazily — only providers that lower the prompt themselves (opencode/hermes) ask for `content`, via promptText. */
function resolveBackend(config: AgentRunConfig): { provider: Provider; binary: string; prompt: PromptInput } {
  const provider = config.provider || piProvider;
  const binary = config.binary ?? config.piBinary ?? provider.binary;
  return { provider, binary, prompt: { path: config.prompt } };
}

/** Read the system-prompt file once, memoized on the PromptInput (a provider lowering prompt text calls this). */
export function promptText(prompt: PromptInput): string {
  return prompt.content ??= readFileSync(prompt.path!, "utf-8");
}

/** Give a provider that declares `prepare` a per-leaf scratch dir (`<tmp>/reharness-<name>-XXXXXX`) and let it
 *  lay down its plumbing (agent definitions / context files) before argv is built. */
function prepareProvider(config: AgentRunConfig, provider: Provider, prompt: PromptInput): void {
  if (!provider.prepare) return;
  config.providerScratchDir ??= mkdtempSync(join(tmpdir(), `reharness-${provider.name}-`));
  provider.prepare(config.providerScratchDir, config, prompt);
}

/** A provider without `extensionArgs` has no extension axis at all: the leaf's extensions degrade loudly. */
function lowerExtensions(config: AgentRunConfig, provider: Provider): string[] {
  const exts = config.extensions ?? [];
  if (!exts.length) return [];
  if (provider.extensionArgs) return provider.extensionArgs(exts, config);
  config.onLine?.(`  ⚠ backend '${provider.name}' has no extension mechanism — ${exts.length} extension(s) not loaded: ${exts.map((e) => e.split("/").pop()).join(", ")}`);
  return [];
}

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
      ts.cacheRead += n.cacheRead || 0; ts.cacheWrite += n.cacheWrite || 0;
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
      cb.onBeat?.(); // any output = the leaf is alive → reset the idle watchdog
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let e: any;
        try { e = JSON.parse(raw); } catch { continue; }
        for (const n of provider.normalize(e, cb.runConfig)) applyEvent(n, cb, ts);
      }
    });
    stream.on("end", () => res());
    stream.on("error", () => res());
  });
}

interface WatchdogCfg { idleMs?: number; maxMs?: number; maxUsd?: number; maxTokens?: number; }

/** The two-timer watchdog for an agent subprocess. L1 idle: no stream event for `idleMs` ⇒ the leaf is hung. L3
 *  hard ceilings: wall-clock `maxMs`, cost `maxUsd`, tokens `maxTokens` — non-extendable, so a live-but-runaway
 *  leaf ("playing solitaire") still dies. On a trip it kills the process and reports the reason; the caller fails
 *  loud with it (never a retry). `base` carries spend/start already booked by earlier retries so ceilings span the
 *  whole leaf. Every knob 0/undefined = disabled; with all disabled this is a no-op. `kick` is the heartbeat. */
function armWatchdog(
  proc: ReturnType<typeof spawn>, cfg: WatchdogCfg, ts: TokenState,
  base: { usd: number; tokens: number; runStart: number }, onTrip: (reason: string) => void,
): { kick: () => void; disarm: () => void } {
  const { idleMs, maxMs, maxUsd, maxTokens } = cfg;
  if (!idleMs && !maxMs && !maxUsd && !maxTokens) return { kick: () => {}, disarm: () => {} };
  let last = Date.now();
  const times = [idleMs, maxMs].filter((x): x is number => !!x);
  const tick = Math.max(200, Math.min(...(times.length ? times : [2000]), 2000)); // fine enough for the smallest deadline
  const timer = setInterval(() => {
    const now = Date.now(), usd = base.usd + ts.costUSD, tok = base.tokens + ts.tokensIn + ts.tokensOut;
    const reason =
      idleMs && now - last > idleMs ? `stalled — no backend activity for ${Math.round((now - last) / 1000)}s (idle limit ${idleMs / 1000}s)`
      : maxMs && now - base.runStart > maxMs ? `exceeded the wall-clock ceiling (${maxMs / 1000}s)`
      : maxUsd && usd > maxUsd ? `exceeded the cost budget ($${usd.toFixed(4)} > $${maxUsd})`
      : maxTokens && tok > maxTokens ? `exceeded the token budget (${tok} > ${maxTokens})`
      : "";
    if (reason) { clearInterval(timer); onTrip(reason); proc.kill("SIGTERM"); }
  }, tick);
  return { kick: () => { last = Date.now(); }, disarm: () => clearInterval(timer) };
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

  const { provider, binary, prompt } = resolveBackend(config);
  prepareProvider(config, provider, prompt);
  const extArgs = lowerExtensions(config, provider);
  const args = [...provider.args("oneshot", config, prompt, config.task), ...extArgs];

  // Cost is accumulated ACROSS attempts (each spawn is a fresh session, so a per-attempt total is summed) and
  // reported once — a retried leaf still records its full spend, and exactly one agent-run.
  const total: AgentUsage = { costUSD: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  const runStart = Date.now();
  let lastCode = 1, lastStderr = "";
  try {
    for (let attempt = 0; ; attempt++) {
      const ts: TokenState = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
      const base = { usd: total.costUSD, tokens: total.tokensIn + total.tokensOut, runStart };
      const { code, stderr, trip } = await oneshotAttempt(config, provider, binary, args, ts, base);
      // A provider with out-of-band usage (hermes --usage-file): harvest it after the attempt — a retried
      // attempt's spend still lands, exactly once per attempt (a stream-emitting provider returns [] here).
      if (provider.finalize) for (const n of provider.finalize(config)) applyEvent(n, { onLine: config.onLine, onStatus: config.onStatus, logFile: config.logFile }, ts);
      total.costUSD += ts.costUSD; total.tokensIn += ts.tokensIn; total.tokensOut += ts.tokensOut; total.cacheRead += ts.cacheRead; total.cacheWrite += ts.cacheWrite; total.model = ts.model || total.model;
      // A watchdog trip (idle / wall-clock / cost / token ceiling) is a hard deterministic kill — fail loud, never retry.
      if (trip) throw new Error(`Agent killed: ${trip}`);
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
function oneshotAttempt(config: AgentRunConfig, provider: Provider, binary: string, args: string[], ts: TokenState, base: { usd: number; tokens: number; runStart: number }): Promise<{ code: number; stderr: string; trip?: string }> {
  return new Promise((res, rej) => {
    const proc = spawn(binary, args, { cwd: provider.cwd?.(config, { path: config.prompt }) ?? config.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let trip: string | undefined;
    const onAbort = () => { if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`); proc.kill("SIGTERM"); };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    const wd = armWatchdog(proc, config, ts, base, (reason) => {
      trip = reason;
      config.onLine?.(`  ⚠ watchdog: ${reason} — killing leaf`);
      if (config.logFile) appendFileSync(config.logFile, `\n[watchdog] ${reason}\n`);
    });

    const parsed = parseJsonEventStream(proc.stdout, provider, { onLine: config.onLine, onStatus: config.onStatus, logFile: config.logFile, onBeat: wd.kick, runConfig: config }, ts);
    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      wd.kick();
      const text = chunk.toString();
      stderrBuf += text;
      if (config.logFile) appendFileSync(config.logFile, redact(`[stderr] ${text}`));
    });

    proc.on("close", async (code) => {
      wd.disarm();
      config.signal?.removeEventListener("abort", onAbort);
      await parsed;
      if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${code ?? 1}\n`);
      res({ code: code ?? 1, stderr: stderrBuf, trip });
    });
    proc.on("error", (e) => { wd.disarm(); config.signal?.removeEventListener("abort", onAbort); rej(spawnError(provider, binary, e)); });
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
 * `turn_end` NormEvent (Pi `agent_end`).
 *
 * The validator is the caller-supplied `validate()` closure (e.g. validateSkeleton for the design agent),
 * returning error strings (empty = clean).
 */
async function runAgentRpc(config: AgentRunConfig): Promise<void> {
  // A backend without RPC support (hermes) fails LOUD before anything is read or spawned — the redirect names a
  // backend that does support the validator flow.
  const declared = (config.provider || piProvider).modes;
  if (declared && !declared.includes("rpc")) {
    throw new Error(`Backend '${(config.provider || piProvider).name}' does not support RPC/validation mode (supported: ${declared.join(", ")}). Use --provider pi or opencode for leaves with validate.`);
  }

  const { provider, binary, prompt } = resolveBackend(config);

  prepareProvider(config, provider, prompt);

  // Two RPC styles behind one contract: stream events in, turn_end out. A persistent provider (Pi's --mode rpc)
  // keeps ONE process alive and takes framed turns on stdin; OpenCode has no stdin protocol, so each turn is a
  // FRESH `run` spawn that --continue's the SAME captured session (context survives; the process model stays
  // uniform — every spawn/parses/kills the watchdog the same way). Provider marks itself via `rpcStyle`.
  if (provider.rpcStyle === "process-per-turn") return runAgentRpcProcessPerTurn(config, provider, binary, prompt);

  const args = provider.args("rpc", config, prompt, config.task);

  const proc = spawn(binary, args, {
    cwd: provider.cwd?.(config, prompt) ?? config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const ts: TokenState = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
  let buf = "";
  let onTurnEnd: (() => void) | null = null;
  // A spawn-level failure (e.g. missing binary) emits 'error' AND 'close'; without a handler Node throws unhandled.
  // Capture it (mapped to a clear message) and release any pending turn so the awaits below surface it, not a hang.
  let spawnErr: Error | null = null;
  proc.on("error", (e) => { spawnErr = spawnError(provider, binary, e); const r = onTurnEnd; onTurnEnd = null; r?.(); });

  // Same two-timer watchdog as one-shot (one live session, so base spend = 0). A trip kills the proc and releases
  // any pending turn; awaitTurn surfaces the reason as a loud failure (never silently completes the turn).
  let tripReason: string | undefined;
  const wd = armWatchdog(proc, config, ts, { usd: 0, tokens: 0, runStart: Date.now() }, (reason) => {
    tripReason = reason;
    config.onLine?.(`  ⚠ watchdog: ${reason} — killing leaf`);
    if (config.logFile) appendFileSync(config.logFile, `\n[watchdog] ${reason}\n`);
    const r = onTurnEnd; onTurnEnd = null; r?.();
  });

  proc.stdout.on("data", (chunk: Buffer | string) => {
    wd.kick();
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let e: any;
      try { e = JSON.parse(raw); } catch { continue; }
      for (const n of provider.normalize(e, config)) {
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
    if (tripReason) throw new Error(`Agent killed: ${tripReason}`); // watchdog trip — fail loud
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
    wd.disarm();
    config.signal?.removeEventListener("abort", onAbort);
    try { proc.stdin.end(); } catch { /* already closed */ }
    proc.kill("SIGTERM"); // RPC mode is a long-lived server — terminate explicitly
    await closed;
    config.onUsage?.({ costUSD: ts.costUSD, tokensIn: ts.tokensIn, tokensOut: ts.tokensOut, cacheRead: ts.cacheRead, cacheWrite: ts.cacheWrite, model: ts.model });
    if (config.logFile) appendFileSync(config.logFile, `\n[exit]\n`);
    if (stderrBuf.trim() && config.onLine) stderrBuf.trim().split("\n").slice(-3).forEach((l) => config.onLine?.(redact(`  ${l}`)));
  }
}

/**
 * RPC for a provider with no stdin session protocol (OpenCode): each turn is a FRESH `run` spawn, continuing the
 * session id the first spawn created (context survives — same conversation, same files). Each attempt reuses the
 * one-shot spawn machinery exactly (same stream parsing, watchdog, finalize), and the provider's args() adds
 * `--continue --session <id>` once the first turn's stream has revealed the id. A turn's end-of-stream IS the
 * turn end (the process exits), so no turn-marker event is needed.
 */
async function runAgentRpcProcessPerTurn(config: AgentRunConfig, provider: Provider, binary: string, prompt: PromptInput): Promise<void> {
  const runValidate = async (): Promise<string[]> => (config.validate ? await config.validate() : []);
  const maxAttempts = 3;
  const total: AgentUsage = { costUSD: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };

  const oneTurn = async (task: string): Promise<void> => {
    if (config.signal?.aborted) throw new Error("Aborted");
    const args = provider.args("rpc", config, prompt, task); // args() continues the session after turn 1
    const ts: TokenState = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
    const base = { usd: total.costUSD, tokens: total.tokensIn + total.tokensOut, runStart: Date.now() };
    const { code, stderr, trip } = await oneshotAttempt(config, provider, binary, args, ts, base);
    if (provider.finalize) for (const n of provider.finalize(config)) applyEvent(n, config, ts);
    total.costUSD += ts.costUSD; total.tokensIn += ts.tokensIn; total.tokensOut += ts.tokensOut; total.cacheRead += ts.cacheRead; total.cacheWrite += ts.cacheWrite; total.model = ts.model || total.model;
    if (trip) throw new Error(`Agent killed: ${trip}`);
    if (config.signal?.aborted) throw new Error("Aborted");
    if (code !== 0) {
      if (stderr.trim()) stderr.trim().split("\n").slice(-3).forEach((l) => config.onLine?.(redact(`  ${l}`)));
      throw new Error(`Agent failed (exit ${code})`);
    }
  };

  try {
    await oneTurn(config.task);
    let errs = await runValidate();
    let attempts = 0;
    while (errs.length && attempts < maxAttempts) {
      config.onLine?.(`  ⚠ validation: ${errs[0]} — re-prompting (${attempts + 1}/${maxAttempts})`);
      if (config.logFile) appendFileSync(config.logFile, `[validate] FAIL:\n- ${errs.join("\n- ")}\n`);
      await oneTurn(`Your output failed validation:\n- ${errs.join("\n- ")}\n\nFix this now and finish — edit only what's needed to resolve the above.`);
      errs = await runValidate();
      attempts++;
    }
    if (errs.length) {
      if (config.logFile) appendFileSync(config.logFile, `[validate] GIVE UP after ${attempts} attempt(s):\n- ${errs.join("; ")}\n`);
      throw new Error(`Validation not satisfied after ${attempts} attempt(s): ${errs.join("; ")}`);
    }
    if (attempts > 0) config.onLine?.(`  ✓ validation passed (${attempts} fix round(s))`);
    if (config.logFile) appendFileSync(config.logFile, `[validate] OK\n`);
  } finally {
    config.onUsage?.(total);
  }
}

/**
 * Spawn an agent with stdio inherited from the parent process — a free-chat session.
 * Returns when the user exits the backend (Ctrl+D / /quit). Throws on non-zero exit.
 */
export async function runInteractive(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  const { provider, binary, prompt } = resolveBackend(config);
  prepareProvider(config, provider, prompt);
  const extArgs = lowerExtensions(config, provider);
  const args = [...provider.args("interactive", config, prompt, config.task), ...extArgs];

  const exitCode: number = await new Promise((res, rej) => {
    const proc = spawn(binary, args, {
      cwd: provider.cwd?.(config, prompt) ?? config.cwd,
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
