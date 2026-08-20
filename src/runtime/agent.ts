import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { Readable } from "stream";
import { piProvider, type Provider, type NormEvent, type AgentMode } from "./providers.js";
import { redact } from "./redact.js";
import { AGENT_RETRIES, AGENT_BACKOFF_MS } from "../config.js";

/** Map a raw spawn failure to an actionable message — a missing backend binary is the #1 first-run stumble. */
function spawnError(provider: Provider, binary: string, e: any): Error {
  if (e?.code === "ENOENT")
    return new Error(`Backend '${provider.name}' not found: '${binary}' is not on PATH. Install it (\`${provider.install}\`) or pass an absolute path via --binary/def.binary.`);
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
  /** Resume an existing backend session instead of starting fresh (`session: "resume"` providers only). Set by the
   *  resume driver between turns; a direct caller can set it to continue a prior leaf's session. */
  sessionId?: string;
  /** Backend reported its session id — the resume driver captures this to re-attach on the next turn. */
  onSession?: (id: string) => void;
}

/** Per-agent LLM spend, summed from the backend's usage events. */
export interface AgentUsage { costUSD: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; model?: string; }

interface ParseCallbacks {
  onLine?: (msg: string) => void;
  onStatus?: (text: string) => void;
  logFile?: string;
  /** Watchdog heartbeat: called on every stream chunk so the idle timer treats any backend output as "alive". */
  onBeat?: () => void;
  /** Backend minted/reported a session id — captured so a `session: "resume"` provider can re-attach next turn. */
  onSession?: (id: string) => void;
}

interface TokenState { model?: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; costUSD: number; }

/** Fresh per-attempt accounting, seeded with the requested model. The seed matters for backends whose usage events
 *  carry no model id (OpenCode's `step-finish` has none, and `--format json` omits the `message.updated` line that
 *  would): without it the status line and the run ledger would show a blank model. A backend that DOES report one
 *  overwrites the seed (`applyEvent`), so a server-side model substitution is still reflected. */
function freshTokenState(config: AgentRunConfig): TokenState {
  return { model: config.model ?? config.piModel, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
}

/** Resolve the backend's executable. */
function resolveBackend(config: AgentRunConfig): { provider: Provider; binary: string } {
  const provider = config.provider || piProvider;
  const binary = config.binary ?? config.piBinary ?? provider.binary;
  return { provider, binary };
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
    case "session":
      // Reported repeatedly (every OpenCode event carries sessionID) — the callback dedupes/keeps the first.
      cb.onSession?.(n.id);
      break;
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
        for (const n of provider.normalize(e)) applyEvent(n, cb, ts);
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

/** Spawn an agent. With a validator → live session with in-session re-prompting; otherwise one-shot (with a
 *  bounded transient-failure retry: a rate-limit / 5xx / dropped connection backs off and retries, while a content
 *  error fails fast — and once the budget is spent the leaf fails loud, so the FSM's fail-loud invariant holds). */
export async function runAgent(config: AgentRunConfig): Promise<void> {
  if (config.signal?.aborted) throw new Error("Aborted");

  if (config.logFile) {
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(config.logFile, redact(`# Agent: ${config.prompt}\n# Task:\n${config.task}\n\n---\n\n`));
  }

  // Multi-turn strategy is the provider's, not the driver's. "stdin" keeps Pi's one-live-process RPC protocol;
  // "resume" re-spawns per turn against a captured session id.
  if (config.validate) {
    const { provider } = resolveBackend(config);
    const mode = provider.session ?? "stdin";
    if (mode === "stdin") return runAgentRpc(config);
    if (mode === "resume") return runAgentResume(config);
  }

  const { provider, binary } = resolveBackend(config);
  const extArgs = lowerExtensions(config, provider);
  const args = [...provider.args("oneshot", config, config.task), ...extArgs];

  // Cost is accumulated ACROSS attempts (each spawn is a fresh session, so a per-attempt total is summed) and
  // reported once — a retried leaf still records its full spend, and exactly one agent-run.
  const total: AgentUsage = { costUSD: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  const runStart = Date.now();
  let lastCode = 1, lastStderr = "";
  try {
    for (let attempt = 0; ; attempt++) {
      const ts: TokenState = freshTokenState(config);
      const base = { usd: total.costUSD, tokens: total.tokensIn + total.tokensOut, runStart };
      const { code, stderr, trip } = await oneshotAttempt(config, provider, binary, args, ts, base);
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

/** Run a provider's `prepare` hook (if any) and fold the result into spawn options. A provider without the hook
 *  yields inherited env and no cleanup — byte-identical to the pre-`prepare` spawn, so Pi is unaffected. */
function stage(provider: Provider, mode: AgentMode, config: AgentRunConfig, sessionId?: string): { env: Record<string, string>; extraArgs: string[]; cwd: string | undefined; cleanup: () => void } {
  const p = provider.prepare?.(mode, config, sessionId);
  return {
    env: p?.env ? { ...process.env, ...p.env } as Record<string, string> : process.env as Record<string, string>,
    extraArgs: p?.extraArgs ?? [],
    cwd: p?.cwd,
    cleanup: () => { try { p?.cleanup?.(); } catch { /* cleanup must never mask the run's outcome */ } },
  };
}

/** One one-shot spawn. Resolves with the exit code + collected stderr (never rejects on a non-zero exit — the
 *  caller decides retry-or-fail); rejects only on a spawn-level error (e.g. binary not found, mapped to a clear msg). */
function oneshotAttempt(config: AgentRunConfig, provider: Provider, binary: string, args: string[], ts: TokenState, base: { usd: number; tokens: number; runStart: number }): Promise<{ code: number; stderr: string; trip?: string }> {
  return new Promise((res, rej) => {
    // Stage provider side-channel state (config dir / env-borne prompt) for THIS attempt. Each retry
    // re-stages, so a scratch dir never leaks across attempts.
    const st = stage(provider, "oneshot", config, config.sessionId);
    const proc = spawn(binary, [...args, ...st.extraArgs], { cwd: st.cwd ?? config.cwd, stdio: ["ignore", "pipe", "pipe"], env: st.env });
    let trip: string | undefined;
    const onAbort = () => { if (config.logFile) appendFileSync(config.logFile, `\n[aborted]\n`); proc.kill("SIGTERM"); };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    const wd = armWatchdog(proc, config, ts, base, (reason) => {
      trip = reason;
      config.onLine?.(`  ⚠ watchdog: ${reason} — killing leaf`);
      if (config.logFile) appendFileSync(config.logFile, `\n[watchdog] ${reason}\n`);
    });

    const cb: ParseCallbacks = { onLine: config.onLine, onStatus: config.onStatus, logFile: config.logFile, onBeat: wd.kick, onSession: config.onSession };
    const parsed = parseJsonEventStream(proc.stdout, provider, cb, ts);
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
      st.cleanup();
      if (config.logFile) appendFileSync(config.logFile, `\n[exit] code=${code ?? 1}\n`);
      res({ code: code ?? 1, stderr: stderrBuf, trip });
    });
    proc.on("error", (e) => { wd.disarm(); config.signal?.removeEventListener("abort", onAbort); st.cleanup(); rej(spawnError(provider, binary, e)); });
  });
}

// ── In-session validation (shared policy, two transports) ─────────────────────

/** The validation policy: run the validator, re-prompt with errors, repeat until clean or maxAttempts.
 *  `sendTurn` is the transport — "write a stdin frame" for Pi (stdin), "respawn with --session" for OpenCode (resume).
 *  Extracted so both transports share one policy, no drift. */
async function driveValidation(
  config: AgentRunConfig,
  sendTurn: (message: string) => Promise<void>,
): Promise<void> {
  const runValidate = async (): Promise<string[]> => (config.validate ? await config.validate() : []);
  const maxAttempts = 3;

  let errs = await runValidate();
  let attempts = 0;
  while (errs.length && attempts < maxAttempts) {
    config.onLine?.(`  ⚠ validation: ${errs[0]} — re-prompting (${attempts + 1}/${maxAttempts})`);
    if (config.logFile) appendFileSync(config.logFile, `[validate] FAIL:\n- ${errs.join("\n- ")}\n`);
    await sendTurn(`Your output failed validation:\n- ${errs.join("\n- ")}\n\nFix this now and finish — edit only what's needed to resolve the above.`);
    errs = await runValidate();
    attempts++;
  }

  if (errs.length) {
    if (config.logFile) appendFileSync(config.logFile, `[validate] GIVE UP after ${attempts} attempt(s):\n- ${errs.join("\n- ")}\n`);
    throw new Error(`Validation not satisfied after ${attempts} attempt(s): ${errs.join("; ")}`);
  }
  if (attempts > 0) config.onLine?.(`  ✓ validation passed (${attempts} fix round(s))`);
  if (config.logFile) appendFileSync(config.logFile, `[validate] OK\n`);
}

/**
 * In-session validation via the backend's RPC/streaming mode (session: "stdin"). reharness drives ONE live session:
 *   prompt(task) → wait for the turn-end event → run the deterministic validator → on failure, send another
 *   prompt with the concrete errors INTO THE SAME live session → repeat until clean or maxAttempts.
 *
 * The orchestrator (not the agent) decides completion — mechanical. The process stays alive across
 * re-prompts, so the prompt cache stays hot and the agent fixes its OWN output in-context (no fresh
 * patch session, no context rebuild). A turn is one framed user message; turn-end is the provider's
 * `turn_end` NormEvent (Pi `agent_end`).
 */
async function runAgentRpc(config: AgentRunConfig): Promise<void> {
  const { provider, binary } = resolveBackend(config);

  const st = stage(provider, "rpc", config);
  const args = [...provider.args("rpc", config), ...st.extraArgs];

  const proc = spawn(binary, args, {
    cwd: st.cwd ?? config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: st.env,
  });

  const ts: TokenState = freshTokenState(config);
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
    if (tripReason) throw new Error(`Agent killed: ${tripReason}`); // watchdog trip — fail loud
    if (spawnErr) throw spawnErr;   // a clear "binary not found" beats a generic "exited before completing"
    if (aborted) throw new Error("Aborted");
    if (exited) throw new Error("Agent process exited before completing the turn");
  };

  try {
    let turn = nextTurn();
    send(provider.frame(config.task));
    await awaitTurn(turn);

    // First validation check — if it passes, no re-prompt needed.
    const runValidate = async (): Promise<string[]> => (config.validate ? await config.validate() : []);
    const firstErrs = await runValidate();
    if (firstErrs.length) {
      // Re-prompt with errors and drive the validation loop.
      await driveValidation(config, async (message) => {
        turn = nextTurn();
        send(provider.frame(message));
        await awaitTurn(turn);
      });
    } else {
      if (config.logFile) appendFileSync(config.logFile, `[validate] OK\n`);
    }
  } finally {
    wd.disarm();
    config.signal?.removeEventListener("abort", onAbort);
    st.cleanup();
    try { proc.stdin.end(); } catch { /* already closed */ }
    proc.kill("SIGTERM"); // RPC mode is a long-lived server — terminate explicitly
    await closed;
    config.onUsage?.({ costUSD: ts.costUSD, tokensIn: ts.tokensIn, tokensOut: ts.tokensOut, cacheRead: ts.cacheRead, cacheWrite: ts.cacheWrite, model: ts.model });
    if (config.logFile) appendFileSync(config.logFile, `\n[exit]\n`);
    if (stderrBuf.trim() && config.onLine) stderrBuf.trim().split("\n").slice(-3).forEach((l) => config.onLine?.(redact(`  ${l}`)));
  }
}

/**
 * In-session validation for backends with NO stdin turn protocol (`session: "resume"` — OpenCode).
 *
 * Same contract as runAgentRpc — the orchestrator decides completion, the agent fixes its OWN output — but the
 * mechanism differs: one spawn PER turn, each re-attaching to the session id the backend reported on turn 1
 * (OpenCode `--session <id>` from its event stream). The agent's context therefore carries across re-prompts
 * exactly as in RPC mode; what's lost is the hot process (each turn pays process startup), which is why "stdin"
 * stays the preferred strategy where a backend offers it.
 *
 * Spend is summed across turns and reported once, so a re-prompted leaf records its full cost and one agent-run.
 */
async function runAgentResume(config: AgentRunConfig): Promise<void> {
  const { provider, binary } = resolveBackend(config);

  const total: AgentUsage = { costUSD: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  const runStart = Date.now();
  let sessionId: string | undefined = config.sessionId;
  const onSession = (id: string) => { if (!sessionId) sessionId = id; };

  /** One turn = one spawn. `message` becomes the task argv for this spawn; turn-end is process exit. */
  const turn = async (message: string): Promise<void> => {
    const ts: TokenState = freshTokenState(config);
    const base = { usd: total.costUSD, tokens: total.tokensIn + total.tokensOut, runStart };
    const turnCfg: AgentRunConfig = { ...config, task: message, sessionId, onSession };
    const extArgs = lowerExtensions(turnCfg, provider);
    const args = [...provider.args("oneshot", turnCfg, message), ...extArgs];
    try {
      const { code, stderr, trip } = await oneshotAttempt(turnCfg, provider, binary, args, ts, base);
      if (trip) throw new Error(`Agent killed: ${trip}`);
      if (config.signal?.aborted) throw new Error("Aborted");
      if (code !== 0) {
        if (stderr.trim()) stderr.trim().split("\n").slice(-3).forEach((l) => config.onLine?.(redact(`  ${l}`)));
        throw new Error(`Agent failed (exit ${code})`);
      }
    } finally {
      total.costUSD += ts.costUSD; total.tokensIn += ts.tokensIn; total.tokensOut += ts.tokensOut;
      total.cacheRead += ts.cacheRead; total.cacheWrite += ts.cacheWrite; total.model = ts.model || total.model;
    }
  };

  try {
    await turn(config.task);
    if (!sessionId) {
      // Without a session id turn 2 would start a FRESH context — the agent would be "fixing" output it can't see.
      // Fail loud rather than silently degrade the self-correction contract.
      const errs0 = config.validate ? await config.validate() : [];
      if (!errs0.length) return;
      throw new Error(`Validation failed and backend '${provider.name}' reported no session id to resume: ${errs0.join("; ")}`);
    }

    // First validation check — if it passes, no re-prompt needed.
    const runValidate = async (): Promise<string[]> => (config.validate ? await config.validate() : []);
    const firstErrs = await runValidate();
    if (firstErrs.length) {
      await driveValidation(config, turn);
    } else {
      if (config.logFile) appendFileSync(config.logFile, `[validate] OK\n`);
    }
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

  const { provider, binary } = resolveBackend(config);
  const st = stage(provider, "interactive", config);
  const extArgs = lowerExtensions(config, provider);
  const args = [...provider.args("interactive", config, config.task), ...extArgs, ...st.extraArgs];

  const exitCode: number = await new Promise((res, rej) => {
    const proc = spawn(binary, args, {
      cwd: st.cwd ?? config.cwd,
      stdio: "inherit",
      env: st.env,
    });
    const onAbort = () => proc.kill("SIGTERM");
    config.signal?.addEventListener("abort", onAbort, { once: true });
    proc.on("close", (code) => {
      config.signal?.removeEventListener("abort", onAbort);
      st.cleanup();
      res(code ?? 1);
    });
    proc.on("error", (e) => { st.cleanup(); rej(spawnError(provider, binary, e)); });
  });

  if (config.signal?.aborted) throw new Error("Aborted");
  if (exitCode !== 0) throw new Error(`Interactive session exited with code ${exitCode}`);
}