// Backend provider adapters. The runtime (agent.ts) is a GENERIC driver — spawn a CLI, stream events, optionally
// drive a long-lived multi-turn session — and everything backend-specific lives behind this one interface:
//   • how the three harness axes + prompt + model lower to argv (per mode), and
//   • how the backend's stdout events normalize to a small common vocabulary, and
//   • how a single user turn is framed onto the session's stdin (RPC).
// Adding a backend = one Provider registered below (today: pi, opencode). The FSM/compiler are
// provider-agnostic — a leaf is just "someone runs it" — and the seam is kept so a new backend is one Provider,
// not a cross-cutting change.
//
// Two axes widen to admit backends that aren't Pi-shaped:
//   • `prepare()` — OpenCode has no --system-prompt flag, so the prompt axis can't lower to argv.
//     A provider gets to stage scratch files and contribute env vars before the spawn (the leaf's cwd is
//     never touched — staged config is routed in through env, so a leaf stays cwd-independent).
//   • `session` — OpenCode has no stdin turn protocol, so validator-driven multi-turn is one spawn per
//     turn resuming a captured session id.

import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { layout } from "../layout.js";
import type { AgentRunConfig } from "./agent.js";

export type AgentMode = "oneshot" | "rpc" | "interactive";

/** How a provider drives a multi-turn (validator-driven) session — the `rpc` mode of the driver.
 *  • "stdin"  — one long-lived process; each turn is a JSON frame written to stdin (Pi).
 *  • "resume" — one spawn PER turn; turn 2+ re-attaches to the session id captured from turn 1. */
export type SessionMode = "stdin" | "resume";

/** Staged per-run side-channel state: env vars to merge into the spawn, plus a cleanup for any scratch dir.
 *  Deliberately NO cwd — the leaf always runs in its own workspace; a provider that stages a config dir routes
 *  it in through env (OPENCODE_CONFIG_DIR), never by relocating the process. A leaf must be reproducible, not
 *  cwd-dependent. `cwd` can come back to this interface when a backend genuinely requires it. */
export interface Prepared {
  env?: Record<string, string>;
  /** Extra argv appended after `args()` — for values only knowable after staging. No registered provider sets
   *  it today (it exists so one can, without a driver change). Anything that must PRECEDE a variadic positional
   *  belongs in `args()` instead — see OpenCode's `--session` for why. */
  extraArgs?: string[];
  /** Called in the driver's `finally`, always, even on abort/throw. Must never throw. */
  cleanup?: () => void;
}

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
  // A backend that mints a session id on its stdout stream reports it once, so `session: "resume"` providers can
  // resume THAT session on the next turn. Pi never emits this (its RPC session is the live stdin pipe).
  | { kind: "session"; id: string }
  | { kind: "turn_end" };

export interface Provider {
  readonly name: string;
  /** Default executable (overridable per run via `config.binary`). */
  readonly binary: string;
  /** How to install it — surfaced verbatim in the ENOENT "not found" error (first-run stumble #1). */
  readonly install: string;
  /** Multi-turn strategy. Absent ⇒ "stdin" (Pi's protocol), so an older provider object still type-checks. */
  readonly session?: SessionMode;
  /** Build the argv (excluding the binary) for a run mode from the leaf config. `task` is absent in interactive
   *  mode without a seed prompt. */
  args(mode: AgentMode, c: AgentRunConfig, task?: string): string[];
  /** One backend stdout event (already JSON-parsed) → zero or more normalized events. */
  normalize(raw: any): NormEvent[];
  /** Frame one user turn as a JSON object written to the RPC session's stdin. Only called when `session` allows rpc. */
  frame(message: string): object;
  /** Render this backend's plugin artifact(s) for a synthesized tool, given the neutral routine module's filename
   *  (a sibling it imports relatively). Pure string generation — written next to the routine at bind time, for ALL
   *  backends, so whichever backend runs the command later finds its variant. Empty ⇒ this backend needs no file. */
  renderTool(routineFile: string): { name: string; content: string }[];
  /** Lower extension refs (synthesized `*.routine.mjs` or hand-written capability files) to this backend's load
   *  flags, given the leaf's run config (for the scratch dir). Absent ⇒ the backend has no extension mechanism;
   *  the driver emits a degrade warning instead of silently dropping them. */
  extensionArgs?(extensions: string[], c: AgentRunConfig): string[];
  /** Stage per-run side-channel state (scratch config dirs, env-borne prompts) before the spawn.
   *  Absent ⇒ nothing to stage: argv + inherited env is the whole contract (Pi). The leaf's cwd is NOT stageable
   *  (see `Prepared`); the config carries `sessionId` on a resume turn — lower it in `args()`, not here, so it
   *  precedes any variadic positional. */
  prepare?(mode: AgentMode, c: AgentRunConfig): Prepared;
}

// ── Pi (original backend) ────────────────────────────────────────────────────
// Pi's `--system-prompt`/`--append-system-prompt` read a FILE, so it takes the prompt path unchanged.
export const piProvider: Provider = {
  name: "pi",
  binary: "pi",
  install: "npm i -g @mariozechner/pi-coding-agent",
  session: "stdin",
  args(mode, c, task) {
    const a =
      mode === "oneshot" ? ["--mode", "json", "-p", "--no-session"]
      : mode === "rpc" ? ["--mode", "rpc", "--no-session"]
      : ["--no-session"];
    if (c.model) a.push("--model", c.model);
    a.push("--system-prompt", c.prompt);
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

// ── OpenCode (sst/opencode) ──────────────────────────────────────────────────
// Verified against the released CLI (`opencode-ai` v1.18.13; `packages/opencode/src/cli/cmd/run.ts`).
//
// Three surfaces differ from Pi and drive everything below:
//  1. NO --system-prompt flag. A system prompt is an *agent* config field, and config text supports `{file:...}`
//     substitution — so we generate a config dir with an agent whose `prompt` is "{file:<c.prompt>}" and route it in
//     with OPENCODE_CONFIG_DIR, then select it with `--agent`. appendPrompt lowers to `instructions`, which is
//     additive by design (the exact base-prompt merge semantics don't matter: either way our text is injected).
//  2. Custom tools are NOT an argv flag. The tool registry globs `{tool,tools}/*.{js,ts}` across config dirs, so the
//     synthesized routine's wrapper is written into `<configdir>/tool/` at prepare time. Tool id = filename stem.
//  3. Permissions: run headlessly WITHOUT --auto and opencode AUTO-REJECTS every permission request (run.ts
//     `permission.asked` → reply "reject"). Pi under --no-session is effectively unattended, so --auto is required
//     for parity — a leaf that silently loses every edit is worse than a loud failure.
//
// Stream: `--format json` emits NDJSON {type, timestamp, sessionID, ...}. Turn completion is NOT observable on
// stdout (the loop breaks on a `session.status`→idle event it does not itself emit), so turn_end comes from process
// exit — which is also why multi-turn is `session: "resume"` rather than a stdin protocol.
export const opencodeProvider: Provider = {
  name: "opencode",
  binary: "opencode",
  install: "npm i -g opencode-ai  (or: brew install anomalyco/tap/opencode — see https://opencode.ai/docs/)",
  session: "resume",
  args(mode, c, task) {
    // `run [message..]` is headless; the TUI is the bare `opencode [project]` command. Both accept
    // --model/--agent/--session/--auto, but they differ in how the task is passed, and it matters: the TUI's
    // positional is a PROJECT PATH, so pushing the task there would be silently read as a directory. The TUI takes
    // the seed via --prompt instead.
    const a = mode === "interactive" ? [] : ["run", "--format", "json"];
    if (c.model) a.push("--model", c.model);
    a.push("--agent", OC_AGENT);
    if (mode !== "interactive") a.push("--auto"); // else every permission request is auto-rejected
    // Session resume is lowered HERE — reading `c.sessionId`, which the resume driver sets on turn 2+ — and not
    // via `Prepared.extraArgs`, because extraArgs land AFTER `args()` and hence after the variadic `message..`
    // positional. Options-after-variadic is a parser dependency (yargs happens to still bind it); options-first
    // is the CLI's own documented shape.
    if (c.sessionId) a.push("--session", c.sessionId);
    if (mode === "interactive") { if (task) a.push("--prompt", task); }
    else a.push(task ?? "");
    return a;
  },
  normalize(e) {
    const out: NormEvent[] = [];
    if (typeof e?.sessionID === "string" && e.sessionID) out.push({ kind: "session", id: e.sessionID });
    const p = e?.part;
    if (e?.type === "tool_use" && p?.tool) {
      // `tool_use` is emitted ONLY for a settled part (status completed|error) — opencode never streams a pending
      // tool in --format json. So both halves are synthesized from this one event: the start carries the args
      // (which file / which command — the useful log line), the end carries the outcome.
      const st = p.state ?? {};
      const input = st.input ?? {};
      out.push({ kind: "tool_start", name: p.tool, detail: String(input.filePath ?? input.path ?? input.command ?? "").slice(0, 60) });
      out.push({ kind: "tool_end", name: p.tool, error: st.status === "error" ? String(st.error ?? "") : undefined });
    } else if (e?.type === "text" && p?.text) {
      out.push({ kind: "text", text: p.text });
    } else if (e?.type === "reasoning" && p?.text) {
      out.push({ kind: "thinking", text: p.text });
    } else if (e?.type === "step_finish") {
      // StepFinishPart is exactly {reason, snapshot?, cost, tokens:{input,output,reasoning,cache:{read,write}}} —
      // note there is NO model field, and `--format json` deliberately omits the `message.updated` line that would
      // carry `modelID`. So the model is not discoverable from this stream; the driver seeds it from config instead.
      // `cost` is per-step, so ADD.
      const t = p?.tokens ?? {};
      out.push({
        kind: "usage",
        tokensIn: t.input || 0, tokensOut: t.output || 0,
        cacheRead: t.cache?.read || 0, cacheWrite: t.cache?.write || 0,
        costUSD: p?.cost || 0,
      });
      if (p?.reason === "stop" || p?.reason === "end_turn") out.push({ kind: "turn_end" });
    } else if (e?.type === "error") {
      out.push({ kind: "tool_end", name: "opencode", error: String(e.error?.data?.message ?? e.error?.name ?? e.error ?? "") });
    }
    return out;
  },
  // Unused: session mode is "resume", so the driver never writes turns to stdin. Kept non-throwing to satisfy the
  // interface (a caller that ignores `session` and frames a turn anyway gets an inert object, not a crash).
  frame(message) { return { type: "prompt", message }; },
  prepare(mode, c) {
    // The agent's `prompt` field takes a config-substitution reference to our prompt FILE — no flag needed.
    const agent: Record<string, unknown> = { mode: "primary", prompt: `{file:${c.prompt}}` };
    if (c.model) agent.model = c.model;
    const cfg: Record<string, unknown> = { $schema: "https://opencode.ai/config.json", agent: { [OC_AGENT]: agent } };
    // Knowledge axis + appendPrompt → `instructions` (a list of file paths, additive to the system prompt).
    const instructions = [...(c.appendPrompt ? [c.appendPrompt] : []), ...(mode !== "interactive" ? c.skills ?? [] : [])];
    if (instructions.length) cfg.instructions = instructions;
    const cfgJson = JSON.stringify(cfg, null, 2);

    // Capability axis: the registry globs `{tool,tools}/*.{js,ts}` in every config dir. Our wrappers are .mjs
    // (ESM, as rendered at bind time), so re-export each through a globbed `.js` shim that imports it by abspath.
    // The shim's default export is the wrapper's {description,args,execute} — the shape opencode's `isPluginTool`
    // guard requires — and the tool id is the shim's filename stem.
    const shims: Array<{ name: string; content: string }> = [];
    if (mode !== "interactive") {
      for (const e of c.extensions ?? []) {
        const wrapper = isRoutine(e) ? e.replace(/\.routine\.mjs$/, ".opencode.mjs") : e;
        const stem = wrapper.split("/").pop()!.replace(/\.(opencode\.)?mjs$/, "").replace(/[^A-Za-z0-9_-]/g, "_");
        // `?? mod` unwraps CJS-interop double-wrapping: a loader that treats this `.js` as CommonJS hands back the
        // ESM namespace as `default`, so the tool object would sit at `default.default` and fail the registry's
        // structural guard silently (verified against Node's own resolver + a transpiling loader).
        shims.push({
          name: `${stem}.js`,
          content: `import mod from ${JSON.stringify(wrapper)};\nexport default mod?.default ?? mod;\n`,
        });
      }
    }

    // The dir is keyed by a hash of its CONTENTS rather than mkdtemp'd per run, because opencode fires a background
    // `npm install @opencode-ai/plugin` into every config dir it loads — and AWAITS it whenever a custom tool is
    // present. A fresh dir per attempt would make every leaf pay a cold, network-dependent install; a content-keyed
    // dir is cold once and warm thereafter, while a changed prompt/toolset still gets a new dir (no stale reuse).
    const key = createHash("sha256").update(cfgJson).update(shims.map((s) => s.name + s.content).join("\0")).digest("hex").slice(0, 16);
    // Location comes from the layout module (the single source of truth for every path reharness touches), so the
    // dir lands under the BUNDLE's run-exhaust `.cache/` — `<project>/reharness/.cache/opencode/…` — not a fresh
    // top-level `.cache/` in the user's project (untracked noise, and `npm install` inside their work tree).
    const dir = join(layout(c.cwd).cache, "opencode", `reharness-oc-${key}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "opencode.json"), cfgJson);
    if (shims.length) {
      // `type: module` is REQUIRED, not cosmetic: the registry globs `*.{js,ts}`, and a bare `.js` holding ESM syntax
      // is module-ambiguous — older runtimes reject it outright and transpiling loaders silently make it CommonJS.
      // (opencode's own background `npm install` merges its dependency into this file and preserves the field.)
      writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
      mkdirSync(join(dir, "tool"), { recursive: true });
      for (const s of shims) writeFileSync(join(dir, "tool", s.name), s.content);
    }

    return {
      // OPENCODE_CONFIG_DIR is prepended to the config-dir search list (project config still loads and could
      // fight our agent definition, so disable it — a leaf must be reproducible, not cwd-dependent). The leaf
      // still runs in its OWN cwd: the config dir is routed in via env, never by relocating the process.
      env: { OPENCODE_CONFIG_DIR: dir, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
      // Deliberately NOT removed: the warm `node_modules` is the point (see the hash note above). It lives under
      // the bundle's .cache/ and is keyed by content, so it is self-limiting and gitignored.
      cleanup: () => {},
    };
  },
  renderTool(routineFile) {
    return [{ name: routineFile.replace(/\.routine\.mjs$/, ".opencode.mjs"), content: opencodeToolSource(routineFile) }];
  },
  // OpenCode stages tool shims in prepare() rather than through a separate argv flag. Declare extensionArgs so the
  // driver's lowerExtensions knows the axis is handled (no false "no extension mechanism" warning), returning []
  // because the shims are already staged — there are no argv flags to add.
  extensionArgs: () => [],
};

/** Name of the generated agent we define and select with --agent (must not collide with a user's own agents). */
const OC_AGENT = "reharness";

/** OpenCode custom tool: a default-exported {description, args, execute}. `args` accepts a plain JSON-Schema
 *  property map (registry.ts `legacyJsonSchema` path) — so no zod dependency is pulled in. */
function opencodeToolSource(routineFile: string): string {
  return `import { tool, run } from "./${routineFile}";
export default {
  description: tool.description,
  args: (tool.schema && tool.schema.properties) || {},
  async execute(args) {
    const r = run(args);
    return typeof r === "string" ? r : JSON.stringify(r);
  },
};
`;
}

const REGISTRY: Record<string, Provider> = { pi: piProvider, opencode: opencodeProvider };

/** Every registered backend — used at tool-bind time to render all variants (any backend may run the command later). */
export function allProviders(): Provider[] { return Object.values(REGISTRY); }

/** Resolve a backend by name (def.provider / RunOptions.provider / REHARNESS_PROVIDER); defaults to Pi. */
export function resolveProvider(name?: string): Provider {
  const p = REGISTRY[name || "pi"];
  if (!p) throw new Error(`Unknown provider "${name}" (known: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
