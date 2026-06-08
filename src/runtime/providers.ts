// Backend provider adapters. The runtime (agent.ts) is a GENERIC driver — spawn a CLI, stream events, optionally
// drive a long-lived multi-turn session — and everything backend-specific lives behind this one interface:
//   • how the three harness axes + prompt + model lower to argv (per mode), and
//   • how the backend's stdout events normalize to a small common vocabulary, and
//   • how a single user turn is framed onto the session's stdin (RPC).
// Adding a backend = one Provider. Today: Pi (the original) and Claude Code (so a Claude Code subscription can drive
// the agents instead of paying per-token). The FSM/compiler are provider-agnostic — a leaf is just "someone runs it".

import type { AgentRunConfig } from "./agent.js";

export type AgentMode = "oneshot" | "rpc" | "interactive";

/** The common event vocabulary every backend stream is normalized into (the only shape the driver understands). */
export type NormEvent =
  | { kind: "tool_start"; name: string; detail?: string }
  | { kind: "tool_end"; name: string; error?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  // `costCumulative`: the backend reports a running session total (Claude `result`), not a per-message delta — set,
  // don't add, so a multi-turn RPC session isn't double-counted. Tokens are always per-message deltas (summed).
  | { kind: "usage"; model?: string; tokensIn: number; tokensOut: number; costUSD: number; costCumulative?: boolean }
  | { kind: "turn_end" };

export interface Provider {
  readonly name: string;
  /** Default executable (overridable per run via `config.binary`). */
  readonly binary: string;
  /** Build the argv (excluding the binary) for a run mode from the leaf config. */
  args(mode: AgentMode, c: AgentRunConfig): string[];
  /** One backend stdout event (already JSON-parsed) → zero or more normalized events. */
  normalize(raw: any): NormEvent[];
  /** Frame one user turn as a JSON object written to the RPC session's stdin. */
  frame(message: string): object;
  /** Render this backend's plugin artifact(s) for a synthesized tool, given the neutral routine module's filename
   *  (a sibling it imports relatively). Pure string generation — written next to the routine at bind time, for ALL
   *  backends, so whichever backend runs the command later finds its variant. Empty ⇒ this backend needs no file. */
  renderTool(routineFile: string): { name: string; content: string }[];
}

// ── Pi (original backend) ────────────────────────────────────────────────────
// prompt/appendPrompt are FILE paths; Pi's `--system-prompt`/`--append-system-prompt` read a file.
export const piProvider: Provider = {
  name: "pi",
  binary: "pi",
  args(mode, c) {
    const a =
      mode === "oneshot" ? ["--mode", "json", "-p", "--no-session"]
      : mode === "rpc" ? ["--mode", "rpc", "--no-session"]
      : ["--no-session"];
    if (c.piModel) a.push("--model", c.piModel);
    a.push("--system-prompt", c.prompt);
    if (c.appendPrompt) a.push("--append-system-prompt", c.appendPrompt);
    if (mode !== "interactive") {
      for (const s of c.skills ?? []) a.push("--skill", s);    // axis: knowledge
      a.push(...piExtensionArgs(c.extensions ?? []));          // axis: capability (synthesized routine → .pi.mjs)
    }
    if (mode === "oneshot" || (mode === "interactive" && c.task)) a.push(c.task);
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
      if (m.usage) out.push({ kind: "usage", model: m.model, tokensIn: m.usage.input || 0, tokensOut: m.usage.output || 0, costUSD: m.usage.cost?.total || 0 });
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
};

// ── Claude Code backend ──────────────────────────────────────────────────────
// `claude -p --output-format stream-json --verbose` emits the raw Anthropic message stream (assistant/user/result).
// The three axes lower differently than Pi: model maps directly (strip a Pi-style `anthropic/` prefix); knowledge
// (skills) has no headless auto-discovery so it is appended to the system prompt; capability (extensions) is an MCP
// server config. prompt/appendPrompt are files ⇒ `--system-prompt-file` / `--append-system-prompt-file`.
export const claudeProvider: Provider = {
  name: "claude",
  binary: "claude",
  args(mode, c) {
    const a: string[] = [];
    if (mode === "oneshot") a.push("-p", "--output-format", "stream-json", "--verbose");
    else if (mode === "rpc") a.push("-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
    const model = c.piModel?.replace(/^anthropic\//, "");
    if (model) a.push("--model", model);
    a.push("--system-prompt-file", c.prompt);
    if (c.appendPrompt) a.push("--append-system-prompt-file", c.appendPrompt);
    if (mode !== "interactive") {
      for (const s of c.skills ?? []) a.push("--append-system-prompt-file", s); // knowledge → appended
      a.push(...claudeExtensionArgs(c.extensions ?? []));                        // capability → MCP server(s)
    }
    if (mode === "oneshot" || (mode === "interactive" && c.task)) a.push(c.task);
    return a;
  },
  normalize(e) {
    const out: NormEvent[] = [];
    if (e.type === "assistant" && e.message) {
      const m = e.message;
      for (const c of m.content || []) {
        if (c.type === "tool_use") out.push({ kind: "tool_start", name: c.name, detail: c.input?.path || c.input?.command?.slice(0, 60) || "" });
        if (c.type === "thinking" && c.thinking) out.push({ kind: "thinking", text: c.thinking });
        if (c.type === "text" && c.text) out.push({ kind: "text", text: c.text });
      }
      if (m.usage) out.push({ kind: "usage", model: m.model, tokensIn: m.usage.input_tokens || 0, tokensOut: m.usage.output_tokens || 0, costUSD: 0 });
    } else if (e.type === "result") {
      out.push({ kind: "usage", tokensIn: 0, tokensOut: 0, costUSD: e.total_cost_usd || 0, costCumulative: true });
      out.push({ kind: "turn_end" });
    }
    // `system` (init) and `user` (tool results) ⇒ [] (the tool call was already logged at `tool_use`)
    return out;
  },
  frame(message) { return { type: "user", message: { role: "user", content: message } }; },
  renderTool(routineFile) { return [{ name: routineFile.replace(/\.routine\.mjs$/, ".mcp.mjs"), content: mcpServerSource(routineFile) }]; },
};

// ── synthesized-tool plumbing (the "extract one neutral routine, render per backend" model) ──────────────────
// A synthesized tool is authored ONCE as a neutral routine module `<name>.routine.mjs` exporting `{ tool, run }`
// (tool = {name, description, schema:JSON-Schema}; run = the pure frozen routine). Each backend renders a thin
// wrapper around it (above), and lowers a `*.routine.mjs` extension ref to its own load flags (below). A non-routine
// extension entry (a hand-written capability file) passes through with the backend's native flag. The file stem
// equals tool.name (the gate enforces this), so the runtime derives tool ids from the path without reading the file.
const isRoutine = (e: string) => e.endsWith(".routine.mjs");
const stemOf = (e: string) => e.replace(/\.routine\.mjs$/, "").split("/").pop()!;

function piExtensionArgs(extensions: string[]): string[] {
  const a: string[] = [];
  for (const e of extensions) a.push("--extension", isRoutine(e) ? e.replace(/\.routine\.mjs$/, ".pi.mjs") : e);
  return a;
}

function claudeExtensionArgs(extensions: string[]): string[] {
  const a: string[] = [];
  const servers: Record<string, { command: string; args: string[] }> = {};
  const allowed: string[] = [];
  for (const e of extensions) {
    if (isRoutine(e)) {
      const name = stemOf(e); // = tool.name (gate-enforced) → MCP server key AND tool name
      servers[name] = { command: "node", args: [e.replace(/\.routine\.mjs$/, ".mcp.mjs")] };
      allowed.push(`mcp__${name}__${name}`);
    } else {
      a.push("--mcp-config", e); // hand-written MCP server config file — passthrough
    }
  }
  if (Object.keys(servers).length) {
    // inline config (server paths are absolute via loadHarness ⇒ robust to a moved project) + the headless allowlist
    a.push("--mcp-config", JSON.stringify({ mcpServers: servers }), "--allowedTools", allowed.join(","));
  }
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

/** Minimal MCP stdio server (newline-delimited JSON-RPC 2.0, zero deps) exposing the routine as one tool. */
function mcpServerSource(routineFile: string): string {
  return `import { tool, run } from "./${routineFile}";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d; const lines = buf.split("\\n"); buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: tool.name, version: "0.0.1" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [{ name: tool.name, description: tool.description, inputSchema: tool.schema }] } });
    else if (method === "tools/call") {
      try { const r = run(params?.arguments || {}); send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }] } }); }
      catch (e) { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e && e.message || e) }], isError: true } }); }
    }
    else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
    else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
`;
}

const REGISTRY: Record<string, Provider> = { pi: piProvider, claude: claudeProvider };

/** Every registered backend — used at tool-bind time to render all variants (any backend may run the command later). */
export function allProviders(): Provider[] { return Object.values(REGISTRY); }

/** Resolve a backend by name (def.provider / RunOptions.provider / REHARNESS_PROVIDER); defaults to Pi. */
export function resolveProvider(name?: string): Provider {
  const p = REGISTRY[name || "pi"];
  if (!p) throw new Error(`Unknown provider "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
