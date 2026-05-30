import { XMLParser } from "fast-xml-parser";
import type { Skeleton, SkeletonState, GuardedTransition, DataAssignment, InputDecl } from "./schema.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseAttributeValue: false,
  isArray: (name) => ["state", "on", "go", "show", "edit", "data", "step", "arg"].includes(name),
});

export function parseSkeletonXML(xml: string): Skeleton {
  const raw = parser.parse(xml);
  if (!raw.skeleton) throw new Error("Expected <skeleton> root element");

  const sk = raw.skeleton;
  const result: Skeleton = {
    id: sk["@_id"] || "",
    description: typeof sk.description === "string" ? sk.description : "",
    usage: typeof sk.usage === "string" ? sk.usage : "",
    initial: sk["@_initial"] || "",
    formatVersion: sk["@_format-version"] || undefined,
    states: {},
  };

  const args = sk.inputs?.arg || [];
  if (args.length) result.inputs = args.map((a: any): InputDecl => {
    const d: InputDecl = { name: a["@_name"] || "" };
    if (a["@_positional"] === "true") d.positional = true;
    if (a["@_flag"]) d.flag = a["@_flag"];
    if (a["@_type"]) d.type = a["@_type"];
    if (a["@_default"] !== undefined) d.default = String(a["@_default"]);
    if (a["@_required"] === "true") d.required = true;
    return d;
  });

  for (const state of sk.state || []) {
    const name = state["@_name"];
    if (!name) throw new Error("<state> missing name attribute");
    if (result.states[name]) throw new Error(`<state name="${name}"> is declared more than once`);
    result.states[name] = parseState(state);
  }

  return result;
}

function parseState(raw: any): SkeletonState {
  const st = parseStateBody(raw);
  if (raw["@_timeout"]) st.timeout = raw["@_timeout"];
  if (raw["@_model-expr"]) st.modelExpr = raw["@_model-expr"];
  const contract = cdataText(raw.contract);
  if (contract) st.contract = contract;
  const reads = parseKeyList(raw["@_reads"]);
  if (reads.length) st.reads = reads;
  const writes = parseKeyList(raw["@_writes"]);
  if (writes.length) st.writes = writes;
  return st;
}

/** Parse a `reads`/`writes` attribute: comma- or whitespace-separated namespace keys (data./config.). */
function parseKeyList(raw: any): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

/** Extract text from an element that may be a plain string or a CDATA-wrapped node. */
function cdataText(node: any): string | undefined {
  if (node == null) return undefined;
  if (typeof node === "string") return node.trim() || undefined;
  const t = node["#text"] ?? node["__cdata"];
  return typeof t === "string" ? t.trim() || undefined : undefined;
}

/** Best-effort parse of <on> transitions — never throws on semantic gaps. A missing event/target
 *  becomes "" so validateSkeleton flags it (invalid identifier / target does not exist), letting the
 *  full error set accumulate in one pass instead of one parse-throw at a time. */
function parseOnList(rawOn: any): Record<string, string | GuardedTransition[]> {
  const on: Record<string, string | GuardedTransition[]> = {};
  for (const o of rawOn || []) {
    const event = o["@_event"] || "";
    if (o["@_target"]) on[event] = o["@_target"];
    else if (o.go) on[event] = parseBranches(o.go);
    else on[event] = "";
  }
  return on;
}

function parseStateBody(raw: any): SkeletonState {
  const type = raw["@_type"];

  if (type === "wait") {
    const st: SkeletonState = {
      type: "wait",
      waitMode: raw["@_mode"] as any,
    };
    if (raw["@_duration"]) st.waitDuration = raw["@_duration"];
    if (raw["@_timeout"]) st.waitTimeout = raw["@_timeout"];
    if (raw["@_path"]) st.waitPath = raw["@_path"];
    if (raw["@_command"]) st.waitCommand = raw["@_command"];
    if (raw["@_port"]) {
      const n = parseInt(raw["@_port"], 10);
      if (Number.isFinite(n)) st.waitPort = n; // bad number → left unset → validateSkeleton flags it
    }
    if (raw["@_poll-interval"]) st.waitPollInterval = raw["@_poll-interval"];
    if (raw.on) st.on = parseOnList(raw.on);
    return st;
  }

  if (type === "call") {
    const skState: SkeletonState = {
      type: "call",
      callSkeleton: raw["@_skeleton"],
    };
    if (raw["@_args"]) skState.callArgsExpr = raw["@_args"];
    if (raw.on) skState.on = parseOnList(raw.on);
    return skState;
  }

  // parallel / loop: routing is unified with normal states — the next state after fan-out / iteration
  // is named by <on event="DONE" target="X"/> (NOT a join= attribute). Captured into join.
  if (type === "parallel") {
    const st: SkeletonState = {
      type: "parallel",
      overExpr: raw["@_over"],
      parallelBranch: raw["@_branch"],
    };
    if (raw["@_concurrency"] !== undefined) {
      const n = parseInt(raw["@_concurrency"], 10);
      if (Number.isFinite(n)) st.concurrency = n;
    }
    parseJoinOn(raw.on, st);
    return st;
  }

  if (type === "loop") {
    const st: SkeletonState = {
      type: "loop",
      loopSteps: (raw.step || []).map((s: any) => s["@_state"] || ""),
    };
    if (raw["@_max"] !== undefined) {
      const n = parseInt(raw["@_max"], 10);
      if (Number.isFinite(n)) st.maxIterations = n;
    }
    if (raw["@_exit"]) st.exitExpr = raw["@_exit"];
    parseJoinOn(raw.on, st);
    return st;
  }

  if (type === "switch") {
    return { type: "switch", branches: parseBranches(raw.go || []) };
  }

  if (type === "check") {
    // Desugar: check expr="X" with TRUE/FALSE events → switch with 2 branches. Best-effort: gaps
    // become "" so validateSkeleton flags them rather than aborting the whole parse.
    const expr = raw["@_expr"] || "";
    const branches: GuardedTransition[] = [];
    let falseTarget = "";
    for (const on of raw.on || []) {
      const event = on["@_event"] || "";
      const target = on["@_target"] || "";
      if (event === "TRUE") branches.push({ target, guard: `expr:${expr}` });
      else if (event === "FALSE") falseTarget = target;
    }
    branches.push({ target: falseTarget });
    return { type: "switch", branches };
  }

  const skState: SkeletonState = { type };
  if (raw["@_status"]) skState.status = raw["@_status"];

  if (type === "approval") {
    if (typeof raw.prompt === "string") skState.prompt = raw.prompt;
    if (raw["@_auto-event"]) skState.autoEvent = raw["@_auto-event"];
    skState.artifacts = extractArtifactPaths(raw.artifacts, "show");
  } else if (type === "interactive") {
    skState.artifacts = extractArtifactPaths(raw.artifacts, "edit");
  } else if (type === "set") {
    skState.dataAssignments = (raw.data || []).map((d: any): DataAssignment => ({
      key: d["@_key"] || "",
      value: d["@_value"] !== undefined ? d["@_value"] : "",
    }));
  }

  if (raw.on) skState.on = parseOnList(raw.on);

  return skState;
}

/** parallel / loop: capture <on event="DONE" target="X"/> as the join, other events (TIMEOUT) into on. */
function parseJoinOn(rawOn: any, st: SkeletonState): void {
  st.on = {};
  for (const o of rawOn || []) {
    const event = o["@_event"] || "";
    const target = o["@_target"] || "";
    if (event === "DONE") st.join = target;
    else st.on[event] = target;
  }
}

function parseBranches(gos: any[]): GuardedTransition[] {
  return gos.map((g: any): GuardedTransition => {
    const gt: GuardedTransition = { target: g["@_target"] || "" };
    const retryKey = g["@_retries-key"];
    const retryMax = g["@_retries-max"];
    const expr = g["@_guard"];
    // Best-effort: prefer retries if both are present; validateSkeleton checks guard validity.
    if (retryKey && retryMax) gt.guard = `retries:${retryKey}<${retryMax}`;
    else if (expr) gt.guard = `expr:${expr}`;
    return gt;
  });
}

function extractArtifactPaths(node: any, tag: "show" | "edit"): string[] | undefined {
  if (!node || !Array.isArray(node[tag])) return undefined;
  const paths = node[tag]
    .map((s: any) => s["@_path"])
    .filter((p: any): p is string => typeof p === "string" && p.length > 0);
  return paths.length ? paths : undefined;
}

export function serializeSkeletonXML(skeleton: Skeleton): string {
  const lines: string[] = [];
  const version = skeleton.formatVersion || "0.5";
  lines.push(`<skeleton id="${esc(skeleton.id)}" initial="${esc(skeleton.initial)}" format-version="${esc(version)}">`);
  lines.push(`  <description>${esc(skeleton.description)}</description>`);
  lines.push(`  <usage>${esc(skeleton.usage)}</usage>`);
  if (skeleton.inputs?.length) {
    lines.push(`  <inputs>`);
    for (const a of skeleton.inputs) {
      const attrs = [`name="${esc(a.name)}"`];
      if (a.positional) attrs.push(`positional="true"`);
      if (a.flag) attrs.push(`flag="${esc(a.flag)}"`);
      if (a.type) attrs.push(`type="${a.type}"`);
      if (a.default !== undefined) attrs.push(`default="${esc(a.default)}"`);
      if (a.required) attrs.push(`required="true"`);
      lines.push(`    <arg ${attrs.join(" ")} />`);
    }
    lines.push(`  </inputs>`);
  }

  for (const [name, state] of Object.entries(skeleton.states)) {
    lines.push("");
    if (state.type === "final") {
      lines.push(`  <state name="${esc(name)}" type="final" status="${state.status || "success"}" />`);
      continue;
    }

    const stateAttrs = [`name="${esc(name)}"`, `type="${state.type}"`];
    if (state.timeout) stateAttrs.push(`timeout="${esc(state.timeout)}"`);
    if (state.modelExpr) stateAttrs.push(`model-expr="${esc(state.modelExpr)}"`);
    if (state.reads?.length) stateAttrs.push(`reads="${esc(state.reads.join(", "))}"`);
    if (state.writes?.length) stateAttrs.push(`writes="${esc(state.writes.join(", "))}"`);
    if (state.type === "approval" && state.autoEvent) stateAttrs.push(`auto-event="${esc(state.autoEvent)}"`);
    if (state.type === "wait") {
      if (state.waitMode) stateAttrs.push(`mode="${state.waitMode}"`);
      if (state.waitDuration) stateAttrs.push(`duration="${esc(state.waitDuration)}"`);
      if (state.waitTimeout) stateAttrs.push(`timeout="${esc(state.waitTimeout)}"`);
      if (state.waitPath) stateAttrs.push(`path="${esc(state.waitPath)}"`);
      if (state.waitCommand) stateAttrs.push(`command="${esc(state.waitCommand)}"`);
      if (state.waitPort !== undefined) stateAttrs.push(`port="${state.waitPort}"`);
      if (state.waitPollInterval) stateAttrs.push(`poll-interval="${esc(state.waitPollInterval)}"`);
      lines.push(`  <state ${stateAttrs.join(" ")}>`);
      lines.push(...emitOnTransitions(state.on));
      lines.push(`  </state>`);
      continue;
    }

    if (state.type === "call") {
      if (state.callSkeleton) stateAttrs.push(`skeleton="${esc(state.callSkeleton)}"`);
      if (state.callArgsExpr) stateAttrs.push(`args="${esc(state.callArgsExpr)}"`);
      lines.push(`  <state ${stateAttrs.join(" ")}>`);
      lines.push(...emitOnTransitions(state.on));
      lines.push(`  </state>`);
      continue;
    }

    if (state.type === "parallel") {
      if (state.overExpr) stateAttrs.push(`over="${esc(state.overExpr)}"`);
      if (state.parallelBranch) stateAttrs.push(`branch="${esc(state.parallelBranch)}"`);
      if (state.concurrency !== undefined) stateAttrs.push(`concurrency="${state.concurrency}"`);
      lines.push(`  <state ${stateAttrs.join(" ")}>`);
      if (state.join) lines.push(`    <on event="DONE" target="${esc(state.join)}" />`);
      lines.push(...emitOnTransitions(state.on));
      lines.push(`  </state>`);
      continue;
    }
    if (state.type === "loop") {
      if (state.maxIterations !== undefined) stateAttrs.push(`max="${state.maxIterations}"`);
      if (state.exitExpr) stateAttrs.push(`exit="${esc(state.exitExpr)}"`);
      lines.push(`  <state ${stateAttrs.join(" ")}>`);
      for (const s of state.loopSteps || []) lines.push(`    <step state="${esc(s)}" />`);
      if (state.join) lines.push(`    <on event="DONE" target="${esc(state.join)}" />`);
      lines.push(...emitOnTransitions(state.on));
      lines.push(`  </state>`);
      continue;
    }
    lines.push(`  <state ${stateAttrs.join(" ")}>`);

    if (state.contract?.trim()) lines.push(`    <contract>${cdata(state.contract.trim())}</contract>`);

    if (state.type === "switch" && state.branches) {
      for (const gt of state.branches) lines.push(`    ${emitGo(gt)}`);
    }

    if (state.type === "approval" && state.prompt) lines.push(`    <prompt>${esc(state.prompt)}</prompt>`);
    if (state.artifacts?.length) {
      const tag = state.type === "interactive" ? "edit" : "show";
      lines.push(`    <artifacts>`);
      for (const path of state.artifacts) lines.push(`      <${tag} path="${esc(path)}" />`);
      lines.push(`    </artifacts>`);
    }
    if (state.type === "set" && state.dataAssignments) {
      for (const a of state.dataAssignments) {
        lines.push(`    <data key="${esc(a.key)}" value="${esc(a.value)}" />`);
      }
    }

    lines.push(...emitOnTransitions(state.on));
    lines.push(`  </state>`);
  }

  lines.push("</skeleton>");
  return lines.join("\n") + "\n";
}

/** Serialize a state's `<on>` transitions (string target → self-closing; guarded array → `<go>` children). */
function emitOnTransitions(on?: Record<string, string | GuardedTransition[]>): string[] {
  const out: string[] = [];
  for (const [event, target] of Object.entries(on || {})) {
    if (typeof target === "string") { out.push(`    <on event="${esc(event)}" target="${esc(target)}" />`); continue; }
    out.push(`    <on event="${esc(event)}">`);
    for (const gt of target) out.push(`      ${emitGo(gt)}`);
    out.push(`    </on>`);
  }
  return out;
}

function emitGo(gt: GuardedTransition): string {
  const parts = [`target="${esc(gt.target)}"`];
  if (gt.guard) {
    const retry = gt.guard.match(/^retries:(\w+)<(\d+)$/);
    if (retry) parts.push(`retries-key="${retry[1]}"`, `retries-max="${retry[2]}"`);
    else if (gt.guard.startsWith("expr:")) parts.push(`guard="${esc(gt.guard.slice(5))}"`);
  }
  return `<go ${parts.join(" ")} />`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap free-form markdown (spec / contract) in CDATA so it can contain |, backticks, <, >, & verbatim.
 *  Splits any literal `]]>` so it can't terminate the section early. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
