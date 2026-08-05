// Backend provider adapters. The runtime (agent.ts) is a GENERIC driver — spawn a CLI, stream events, optionally
// drive a long-lived multi-turn session — and everything backend-specific lives behind this one interface:
//   • how the three harness axes + prompt + model lower to argv (per mode), and
//   • how the backend's stdout events normalize to a small common vocabulary, and
//   • how a single user turn is framed onto the session's stdin (RPC).
// Adding a backend = one Provider registered below (today: pi, opencode, hermes). The FSM/compiler are
// provider-agnostic — a leaf is just "someone runs it" — and the seam is kept so a new backend is one Provider,
// not a cross-cutting change.

import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { promptText, type AgentRunConfig } from "./agent.js";

export type AgentMode = "oneshot" | "rpc" | "interactive";

/** A system prompt lowered to whatever the backend natively reads: { path } = the backend takes a FILE flag
 *  (Pi's --system-prompt); { content } = the backend has no file flag, so the Provider inlines the text its own
 *  way (a scratch agent definition for OpenCode's --agent, a scratch cwd AGENTS.md for Hermes). */
export interface PromptInput { path?: string; content?: string }

/** The common event vocabulary every backend stream is normalized into (the only shape the driver understands). */
export type NormEvent =
  | { kind: "tool_start"; name: string; detail?: string }
  | { kind: "tool_end"; name: string; error?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  // `costCumulative`: a backend that reports a running session total (rather than per-message deltas) sets this — the
  // driver SETs rather than ADDs so a multi-turn RPC session isn't double-counted. Tokens are always per-message deltas.
  // tokensIn/Out = UNCACHED input / output. cacheRead/cacheWrite = cached-input read / cache-creation tokens —
  // the bulk of input under prompt caching (omitting them undercounts input ~30×). costUSD is the cache-discounted $.
  | { kind: "usage"; model?: string; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number; costUSD: number; costCumulative?: boolean }
  | { kind: "turn_end" };

export interface Provider {
  readonly name: string;
  /** Default executable (overridable per run via `config.binary`/`config.piBinary`). */
  readonly binary: string;
  /** Shown when the executable isn't on PATH (install command + pointer). Absent ⇒ a generic missing-binary msg. */
  readonly installHint?: string;
  /** Modes this backend can run (absent ⇒ all three). The driver rejects an unsupported mode before spawning —
   *  e.g. hermes is oneshot/interactive only, so a leaf with `validate` (RPC) fails loud with a redirect. */
  readonly modes?: readonly AgentMode[];
  /** How the driver drives a validated (rpc) leaf: absent/"persistent" = one long-lived process fed framed turns
   *  on stdin (Pi); "process-per-turn" = each turn is a fresh spawn continuing the same backend session (OpenCode
   *  has no stdin protocol — the session id is captured from the stream and re-passed via argv). */
  readonly rpcStyle?: "persistent" | "process-per-turn";
  /** Build the argv (excluding the binary) for a run mode from the leaf config. `prompt` is the resolved
   *  PromptInput (the driver read the file); `task` is absent in interactive mode without a seed prompt. */
  args(mode: AgentMode, c: AgentRunConfig, prompt: PromptInput, task?: string): string[];
  /** One backend stdout event (already JSON-parsed) → zero or more normalized events. `c` is the leaf's run
   *  config, when a provider needs it (OpenCode stashes the rpc session id into its scratch dir). */
  normalize(raw: any, c?: AgentRunConfig): NormEvent[];
  /** Frame one user turn as a JSON object written to the RPC session's stdin. Only called when `mode` allows rpc. */
  frame(message: string): object;
  /** Render this backend's plugin artifact(s) for a synthesized tool, given the neutral routine module's filename
   *  (a sibling it imports relatively). Pure string generation — written next to the routine at bind time, for ALL
   *  backends, so whichever backend runs the command later finds its variant. Empty ⇒ this backend needs no file. */
  renderTool(routineFile: string): { name: string; content: string }[];
  /** Lower extension refs (synthesized `*.routine.mjs` or hand-written capability files) to this backend's load
   *  flags, given the leaf's run config (for the scratch dir). Absent ⇒ the backend has no extension mechanism;
   *  the driver emits a degrade warning instead of silently dropping them. */
  extensionArgs?(extensions: string[], c: AgentRunConfig): string[];
  /** cwd override for the spawned process (Hermes reads context files from cwd, so it needs a scratch dir).
   *  Absent ⇒ the leaf's regular cwd. */
  cwd?(c: AgentRunConfig, prompt: PromptInput): string | undefined;
  /** Called once after a successful process exit so the provider can harvest out-of-band artifacts (Hermes's
   *  `--usage-file`, which is the ONLY place its token/cost spend lands — its headless stdout carries no usage). */
  finalize?(c: AgentRunConfig): NormEvent[];
  /** A provider that needs a prepared scratch dir (its own agent-definition / context-file plumbing) declares
   *  this; the driver creates `<tmp>/reharness-<name>-<n>`, sets `c.providerScratchDir`, and calls this before
   *  args(). Absent ⇒ no scratch dir is prepared. */
  prepare?(scratch: string, c: AgentRunConfig, prompt: PromptInput): void;
}

// ── Pi (original backend) ────────────────────────────────────────────────────
// Pi's `--system-prompt`/`--append-system-prompt` read a FILE, so it takes the prompt path unchanged.
export const piProvider: Provider = {
  name: "pi",
  binary: "pi",
  installHint: "npm i -g @mariozechner/pi-coding-agent",
  args(mode, c, prompt, task) {
    if (!prompt.path) throw new Error("Backend 'pi' requires a system-prompt file");
    const a =
      mode === "oneshot" ? ["--mode", "json", "-p", "--no-session"]
      : mode === "rpc" ? ["--mode", "rpc", "--no-session"]
      : ["--no-session"];
    const model = c.model ?? c.piModel;
    if (model) a.push("--model", model);
    a.push("--system-prompt", prompt.path);
    if (c.appendPrompt) a.push("--append-system-prompt", c.appendPrompt);
    if (mode !== "interactive") for (const s of c.skills ?? []) a.push("--skill", s); // axis: knowledge
    // axis: capability rides provider.extensionArgs (called by the driver) — not repeated here
    if (mode === "oneshot" || (mode === "interactive" && task)) a.push(task ?? "");
    return a;
  },
  normalize(e) {
    const out: NormEvent[] = [];
    if (e.type === "tool_execution_start" && e.toolName) {
      out.push({ kind: "tool_start", name: e.toolName, detail: e.args?.path || e.args?.command?.slice(0, 60) || "" });
    } else if (e.type === "tool_execution_end" && e.toolName) {
      out.push({ kind: "tool_end", name: e.toolName, error: e.isError ? (e.result?.content?.[0]?.text || "") : undefined });
    } else if (e.type === "message_end" && e.message?.role === "assistant") {
      const m = e.message;
      if (m.usage) out.push({ kind: "usage", model: m.model, tokensIn: m.usage.input || 0, tokensOut: m.usage.output || 0, cacheRead: m.usage.cacheRead || 0, cacheWrite: m.usage.cacheWrite || 0, costUSD: m.usage.cost?.total || 0 });
      for (const c of m.content || []) {
        if (c.type === "thinking" && c.thinking) out.push({ kind: "thinking", text: c.thinking });
        if (c.type === "text" && c.text) out.push({ kind: "text", text: c.text });
      }
    } else if (e.type === "agent_end") {
      out.push({ kind: "turn_end" });
    }
    // `response` / `extension_ui_request` / `extension_error` / `queue_update` ⇒ [] (RPC acks / headless-irrelevant)
    return out;
  },
  frame(message) { return { type: "prompt", message }; },
  renderTool(routineFile) { return [{ name: routineFile.replace(/\.routine\.mjs$/, ".pi.mjs"), content: piToolSource(routineFile) }]; },
  extensionArgs: (extensions) => piExtensionArgs(extensions),
};

// ── synthesized-tool plumbing (the "extract one neutral routine, render per backend" model) ──────────────────
// A synthesized tool is authored ONCE as a neutral routine module `<name>.routine.mjs` exporting `{ tool, run }`
// (tool = {name, description, schema:JSON-Schema}; run = the pure frozen routine). A backend renders a thin wrapper
// around it (Pi: `renderTool` above) and lowers a `*.routine.mjs` extension ref to its own load flags (below). A
// non-routine extension entry (a hand-written capability file) passes through with the backend's native flag.
const isRoutine = (e: string) => e.endsWith(".routine.mjs");

function piExtensionArgs(extensions: string[]): string[] {
  const a: string[] = [];
  for (const e of extensions) a.push("--extension", isRoutine(e) ? e.replace(/\.routine\.mjs$/, ".pi.mjs") : e);
  return a;
}

/** Pi extension wrapping the neutral routine (parameters = the routine's JSON Schema — Pi accepts it directly). */
function piToolSource(routineFile: string): string {
  return `import { tool, run } from "./${routineFile}";
export default function (pi) {
  pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.schema,
    execute: async (_id, params) => {
      const r = run(params);
      return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }], details: {} };
    },
  });
}
`;
}

// ── OpenCode (anomalyco/opencode — https://opencode.ai) ──────────────────────
// Pinned facts (docs + source, opencode 0.20-era; verified 2026-08):
//   • Headless: `opencode run --format json "task"`. stdout is NDJSON, one per line:
//       {"type":"step_start"|"step_finish"|"text"|"reasoning"|"tool_use"|"error","timestamp":N,"sessionID":"ses_…",...}
//     `step_finish.part` carries { reason, cost: number, tokens: { input, output, reasoning, cache: { read, write } } }.
//     `tool_use.part` is a completed/errored ToolPart: { type:"tool", tool, state: { status:"completed"|"error", input?, output?, error? } }.
//     `text.part.text` is the assistant's final text (emitted once, at part end). An "error" line also sets exit≠0.
//   • Model: `-m provider/model`. Skills: `.opencode/skills/<n>/SKILL.md` dirs picked up from cwd — our absolute
//     per-leaf skill FILES are concatenated into the prompt (their YAML frontmatter stripped) instead.
//   • NO --system-prompt flag: the prompt is lowered to a scratch agent definition
//     (markdown frontmatter `{ mode: primary, model? }` + the prompt body) selected with `--agent reharness`.
//   • Session: `run` always creates one. A "long-lived" RPC session = REUSING one session id across spawns:
//     capture `sessionID` from stream lines, then `run --continue --session <id> --format json "next turn"`.
//     (The alternative keep-alive transports — `opencode serve` HTTP / `opencode acp` JSON-RPC — are deliberately
//     not used: process-per-turn keeps the driver's spawn/kill/watchdog model identical across providers.)
//   • Tools: `.opencode/tools/*.ts`. A synthesized routine renders as `<name>.opencode.ts` importing @opencode-ai/plugin;
//     loaded by placing a symlinked `.opencode/tools/` dir in the scratch agent dir (cwd stays the user's).
export const opencodeProvider: Provider = {
  name: "opencode",
  binary: "opencode",
  installHint: "npm i -g opencode-ai  (or: brew install anomalyco/tap/opencode — see https://opencode.ai/docs/)",
  rpcStyle: "process-per-turn",
  args(mode, c, prompt, task) {
    const sys = promptText(prompt);
    const model = c.model ?? c.piModel;
    if (mode === "interactive") {
      // The TUI has no --agent/--system flag: bare `opencode` runs the user's default agent; the leaf's prompt +
      // task ride along as the prefill (--prompt seeds the first user message). Model = the user's config.
      const know = joinedSkills(c.skills ?? []);
      const seed = [`[Context from the pipeline — treat as instructions]\n${sys}`, know ? `[Additional knowledge]\n${know}` : "", task ?? ""].filter(Boolean).join("\n\n---\n\n");
      return seed ? ["--prompt", seed] : [];
    }
    const dir = scratchDir(c); // guaranteed by prepare()
    // scratch agent definition (frontmatter selects the model) — re-written per spawn so a re-prompt edits take
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "reharness.md"), `---\nmode: primary${model ? `\nmodel: ${model}` : ""}\n---\n\n${prompt.content}\n`);
    if (c.appendPrompt) appendFileSync(join(dir, "agents", "reharness.md"), `\n\n${readFileSync(c.appendPrompt, "utf-8")}`);
    const a = ["run", "--format", "json", "--agent", "reharness", "--dir", dir, "--auto"];
    // when unspecified the model comes from the user's opencode.json/config — left untouched
    if (mode === "rpc" && readSessionId(c)) a.push("--continue", "--session", readSessionId(c)!);
    const know = joinedSkills(c.skills ?? []);
    a.push((know ? `[Additional knowledge]\n${know}\n\n---\n\n` : "") + (task ?? "")); // oneshot task / rpc turn
    return a;
  },
  normalize(e, c) {
    const out: NormEvent[] = [];
    if (e.sessionID && c) {
      // RPC process-per-turn: remember the session the first spawn created so the re-prompt continues it.
      try { writeFileSync(join(scratchDir(c), "session.id"), e.sessionID); } catch { /* scratch gone */ }
    }
    if (e.type === "tool_use" && e.part?.tool) {
      const st = e.part.state ?? {};
      const detail = st.input?.path || st.input?.command?.slice?.(0, 60) || "";
      out.push({ kind: "tool_start", name: e.part.tool, detail });
      out.push({ kind: "tool_end", name: e.part.tool, error: st.status === "error" ? String(st.error ?? "") : undefined });
    } else if (e.type === "step_finish" && e.part) {
      const t = e.part.tokens ?? {};
      out.push({ kind: "usage", tokensIn: t.input || 0, tokensOut: t.output || 0, cacheRead: t.cache?.read || 0, cacheWrite: t.cache?.write || 0, costUSD: e.part.cost || 0 });
      if (e.part.reason === "stop" || e.part.reason === "end_turn") out.push({ kind: "turn_end" });
    } else if (e.type === "text" && e.part?.text) {
      out.push({ kind: "text", text: e.part.text });
    } else if (e.type === "reasoning" && e.part?.text) {
      out.push({ kind: "thinking", text: e.part.text });
    }
    // step_start / error (exit code carries it) / anything else ⇒ []
    return out;
  },
  prepare(scratch) { mkdirSync(join(scratch, ".opencode", "tools"), { recursive: true }); },
  frame(message) {
    // process-per-turn RPC: the "frame" is the next turn's task string, passed through by the driver
    // (run -s <captured session>). The object shape is unused for this provider.
    return { type: "prompt", message };
  },
  renderTool(routineFile) { return [{ name: routineFile.replace(/\.routine\.mjs$/, ".opencode.ts"), content: opencodeToolSource(routineFile) }]; },
  extensionArgs(extensions, c) {
    // routines render as .opencode.ts custom tools, symlinked into the scratch dir's .opencode/tools/
    for (const e of extensions) linkOpencodeTool(scratchDir(c), isRoutine(e) ? e.replace(/\.routine\.mjs$/, ".opencode.ts") : e);
    return []; // loading is filesystem-side, no argv
  },
};

/** The per-leaf scratch dir the driver prepared (prepare()); absent for hand-driven calls without one. */
function scratchDir(c: AgentRunConfig): string { return c.providerScratchDir ?? c.cwd; }

/** Where the OpenCode NDJSON stream's session id is kept between the two RPC spawns. */
function readSessionId(c: AgentRunConfig): string | undefined {
  try { return readFileSync(join(scratchDir(c), "session.id"), "utf-8").trim() || undefined; } catch { return undefined; }
}

function linkOpencodeTool(scratch: string, file: string): void {
  const dir = join(scratch, ".opencode", "tools");
  try {
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, file.split("/").pop()!);
    if (!existsSync(dest)) symlinkSync(file, dest);
  } catch { /* best-effort: a failed link surfaces as a missing tool inside the backend, not our crash */ }
}

/** OpenCode custom tool wrapping the neutral routine (args = the routine's JSON Schema, lowered to zod field-by-field). */
function opencodeToolSource(routineFile: string): string {
  return `import { tool } from "@opencode-ai/plugin";
import { tool as def, run } from "./${routineFile}";
const z = tool.schema;
const args = Object.fromEntries(Object.entries(def.schema?.properties ?? {}).map(([k, v]) => {
  const req = def.schema?.required?.includes(k);
  let s = v.type === "number" || v.type === "integer" ? z.number() : v.type === "boolean" ? z.boolean() : v.type === "array" ? z.array(z.any()) : z.string();
  if (v.description) s = s.describe(v.description);
  return [k, req ? s : s.optional()];
}));
export default tool({
  description: def.description ?? "",
  args,
  async execute(params) { const r = run(params); return typeof r === "string" ? r : JSON.stringify(r); },
});
`;
}

// ── Hermes (NousResearch hermes-agent — https://github.com/NousResearch/hermes-agent) ──
// Pinned facts (source-verified, hermes-agent v0.20; verified 2026-08):
//   • Headless: `hermes -z "task"` — final response TEXT ONLY on stdout (the source redirects both stdout and
//     stderr to /dev/null during the run). There is NO NDJSON/event-stream mode in the headless CLI (verified in
//     hermes_cli/oneshot.py — no --json/--stream). So this provider emits no tool/text/thinking stream events:
//     the log shows the leaf as quiet-but-working, guarded by the wall-clock/cost ceilings instead of liveness.
//   • Usage/cost: `--usage-file <path>` writes a JSON report even on failure:
//       { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, model, … }
//     This is the ONLY place spend lands — finalize() reads it after exit.
//   • Model: `-m vendor/model` (OpenRouter-style); `--provider` requires `--model`. Skills: `-s <name>` (preloads
//     from ~/.hermes/skills/ — our per-leaf skill files are joined into an AGENTS.md context file instead).
//   • Context: AGENTS.md/SOUL.md in the CWD are auto-injected — so the spawn runs in a scratch dir
//     (providerRunId-named, created by the driver's prepare()) containing the system prompt + skill text; the
//     actual file work happens because the task text carries absolute paths. --ignore-user-config/--ignore-rules
//     keep the run hermetic; -y auto-approves (a headless leaf has no approver); --max-turns 20 bounds it.
//   • RPC/validate: UNSUPPORTED (hermes acp exists but is a different transport, deliberately out of scope) —
//     `modes` below makes the driver reject it pre-spawn. Interactive mode passes a model/env through unchanged.
export const hermesProvider: Provider = {
  name: "hermes",
  binary: "hermes",
  installHint: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash  (see https://github.com/NousResearch/hermes-agent)",
  modes: ["oneshot", "interactive"],
  args(mode, c, prompt, task) {
    const model = c.model ?? c.piModel;
    if (mode === "interactive") {
      const a: string[] = [];
      if (model) a.push("-m", model);
      for (const s of c.skills ?? []) a.push("-s", s); // names in ~/.hermes/skills — per-user config territory
      return a;
    }
    const dir = scratchDir(c);
    // The driver wrote <dir>/AGENTS.md (prompt content + append + skill text) — hermes auto-injects it from cwd.
    const a = ["-z", task ?? "", "--ignore-user-config", "--ignore-rules", "-y", "--max-turns", "20",
      "--usage-file", join(dir, "usage.json")];
    if (model) a.push("-m", model);
    return a;
  },
  cwd(c) { return c.providerScratchDir; }, // AGENTS.md context comes from cwd ⇒ the prepared scratch dir
  normalize() {
    // hermes -z emits only the final response text (not JSON) — the driver's JSON parse skips it. Usage arrives
    // out-of-band via finalize(). No stream events by design (see the pinned comment above).
    return [];
  },
  frame() {
    throw new Error("Backend 'hermes' does not support RPC/validation mode (supported: oneshot, interactive). Use --provider pi or opencode for leaves with validate.");
  },
  renderTool() { return []; }, // no plugin mechanism — harness.json extensions degrade with a warn (driver)
  prepare(scratch, c, prompt) {
    // The system prompt + append + per-leaf skill text land in the scratch cwd's AGENTS.md (auto-injected).
    const know = joinedSkills(c.skills ?? []);
    writeFileSync(join(scratch, "AGENTS.md"),
      promptText(prompt)
      + (c.appendPrompt ? `\n\n${readFileSync(c.appendPrompt, "utf-8")}` : "")
      + (know ? `\n\n[Additional knowledge]\n${know}\n` : ""));
  },
  finalize(c) {
    try {
      const u = JSON.parse(readFileSync(join(scratchDir(c), "usage.json"), "utf-8"));
      return [{ kind: "usage", model: u.model, tokensIn: u.input_tokens || 0, tokensOut: u.output_tokens || 0, cacheRead: u.cache_read_tokens || 0, cacheWrite: u.cache_write_tokens || 0, costUSD: u.estimated_cost_usd || 0 }];
    } catch { return []; } // no report (e.g. binary refused to write it) ⇒ $0, visible in the verdict
  },
};

/** Join the per-leaf skill files into one text block (YAML frontmatter stripped) for providers without a native
 *  per-leaf skill-file flag. */
function joinedSkills(files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    try { parts.push(readFileSync(f, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "").trim()); } catch { /* missing skill ⇒ backend-level absence */ }
  }
  return parts.filter(Boolean).join("\n\n");
}

const REGISTRY: Record<string, Provider> = { pi: piProvider, opencode: opencodeProvider, hermes: hermesProvider };

/** Every registered backend — used at tool-bind time to render all variants (any backend may run the command later). */
export function allProviders(): Provider[] { return Object.values(REGISTRY); }

/** Resolve a backend by name (def.provider / RunOptions.provider / REHARNESS_PROVIDER); defaults to Pi. */
export function resolveProvider(name?: string): Provider {
  const p = REGISTRY[name || "pi"];
  if (!p) throw new Error(`Unknown provider "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
