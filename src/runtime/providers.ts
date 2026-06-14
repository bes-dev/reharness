// Backend provider adapters. The runtime (agent.ts) is a GENERIC driver — spawn a CLI, stream events, optionally
// drive a long-lived multi-turn session — and everything backend-specific lives behind this one interface:
//   • how the three harness axes + prompt + model lower to argv (per mode), and
//   • how the backend's stdout events normalize to a small common vocabulary, and
//   • how a single user turn is framed onto the session's stdin (RPC).
// Adding a backend = one Provider. Today: Pi only (the original). The FSM/compiler are provider-agnostic — a leaf
// is just "someone runs it" — and the seam is kept so a new backend is one Provider, not a cross-cutting change.

import type { AgentRunConfig } from "./agent.js";

export type AgentMode = "oneshot" | "rpc" | "interactive";

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

const REGISTRY: Record<string, Provider> = { pi: piProvider };

/** Every registered backend — used at tool-bind time to render all variants (any backend may run the command later). */
export function allProviders(): Provider[] { return Object.values(REGISTRY); }

/** Resolve a backend by name (def.provider / RunOptions.provider / REHARNESS_PROVIDER); defaults to Pi. */
export function resolveProvider(name?: string): Provider {
  const p = REGISTRY[name || "pi"];
  if (!p) throw new Error(`Unknown provider "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
