import { XMLParser } from "fast-xml-parser";
import type { Skeleton, SkeletonState, GuardedTransition, DataAssignment } from "./schema.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseAttributeValue: false,
  isArray: (name) => ["state", "on", "go", "show", "edit", "data", "step"].includes(name),
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

  for (const state of sk.state || []) {
    const name = state["@_name"];
    if (!name) throw new Error("<state> missing name attribute");
    result.states[name] = parseState(name, state);
  }

  return result;
}

function parseState(name: string, raw: any): SkeletonState {
  const st = parseStateBody(name, raw);
  if (raw["@_timeout"]) st.timeout = raw["@_timeout"];
  return st;
}

function parseStateBody(name: string, raw: any): SkeletonState {
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
      if (!Number.isFinite(n)) throw new Error(`Wait state '${name}' port must be a number`);
      st.waitPort = n;
    }
    if (raw["@_poll-interval"]) st.waitPollInterval = raw["@_poll-interval"];
    if (raw.on) {
      st.on = {};
      for (const on of raw.on) {
        const event = on["@_event"];
        if (!event) throw new Error(`<on> missing event in state '${name}'`);
        if (on["@_target"]) st.on[event] = on["@_target"];
        else if (on.go) st.on[event] = parseBranches(on.go, name);
        else throw new Error(`<on event="${event}"> in state '${name}' has no target`);
      }
    }
    return st;
  }

  if (type === "call") {
    const skState: SkeletonState = {
      type: "call",
      callSkeleton: raw["@_skeleton"],
    };
    if (raw["@_args"]) skState.callArgsExpr = raw["@_args"];
    // Call states still have `on` transitions for success/error — fall through to standard on parsing
    if (raw.on) {
      skState.on = {};
      for (const on of raw.on) {
        const event = on["@_event"];
        if (!event) throw new Error(`<on> missing event in state '${name}'`);
        if (on["@_target"]) skState.on[event] = on["@_target"];
        else if (on.go) skState.on[event] = parseBranches(on.go, name);
        else throw new Error(`<on event="${event}"> in state '${name}' has no target or guarded <go> children`);
      }
    }
    return skState;
  }

  if (type === "parallel") {
    const st: SkeletonState = {
      type: "parallel",
      overExpr: raw["@_over"],
      parallelBranch: raw["@_branch"],
      parallelJoin: raw["@_join"],
    };
    if (raw["@_concurrency"] !== undefined) {
      const n = parseInt(raw["@_concurrency"], 10);
      if (!Number.isFinite(n)) throw new Error(`Parallel state '${name}' concurrency must be a number`);
      st.concurrency = n;
    }
    if (raw.on) {
      st.on = {};
      for (const on of raw.on) {
        const event = on["@_event"];
        if (event !== "TIMEOUT") throw new Error(`Parallel state '${name}': only TIMEOUT event allowed in <on>`);
        if (on["@_target"]) st.on[event] = on["@_target"];
        else throw new Error(`<on event="${event}"> in state '${name}' has no target`);
      }
    }
    return st;
  }

  if (type === "loop") {
    const steps = (raw.step || []).map((s: any) => {
      const sn = s["@_state"];
      if (!sn) throw new Error(`Loop state '${name}' <step> missing 'state' attribute`);
      return sn;
    });
    const st: SkeletonState = {
      type: "loop",
      loopSteps: steps,
      parallelJoin: raw["@_join"],
    };
    if (raw["@_max"] !== undefined) {
      const n = parseInt(raw["@_max"], 10);
      if (!Number.isFinite(n)) throw new Error(`Loop state '${name}' max must be a number`);
      st.maxIterations = n;
    }
    if (raw["@_exit"]) st.exitExpr = raw["@_exit"];
    if (raw.on) {
      st.on = {};
      for (const on of raw.on) {
        const event = on["@_event"];
        if (event !== "TIMEOUT") throw new Error(`Loop state '${name}': only TIMEOUT event allowed in <on>`);
        if (on["@_target"]) st.on[event] = on["@_target"];
        else throw new Error(`<on event="${event}"> in state '${name}' has no target`);
      }
    }
    return st;
  }

  if (type === "switch") {
    return { type: "switch", branches: parseBranches(raw.go || [], name) };
  }

  if (type === "check") {
    // Desugar: check expr="X" with TRUE/FALSE events → switch with 2 branches.
    const expr = raw["@_expr"];
    if (!expr) throw new Error(`Check state '${name}' missing expr attribute`);
    const branches: GuardedTransition[] = [];
    let falseTarget: string | undefined;
    for (const on of raw.on || []) {
      const event = on["@_event"];
      const target = on["@_target"];
      if (!event || !target) throw new Error(`Check state '${name}' <on> needs event + target`);
      if (event === "TRUE") branches.push({ target, guard: `expr:${expr}` });
      else if (event === "FALSE") falseTarget = target;
      else throw new Error(`Check state '${name}': only TRUE/FALSE events allowed, got '${event}'`);
    }
    if (!falseTarget) throw new Error(`Check state '${name}' missing <on event="FALSE">`);
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
    skState.dataAssignments = (raw.data || []).map((d: any): DataAssignment => {
      const key = d["@_key"];
      const value = d["@_value"];
      if (!key || value === undefined) throw new Error(`Set state '${name}' <data> needs key and value attributes`);
      return { key, value };
    });
  }

  if (raw.on) {
    skState.on = {};
    for (const on of raw.on) {
      const event = on["@_event"];
      if (!event) throw new Error(`<on> missing event in state '${name}'`);
      if (on["@_target"]) {
        skState.on[event] = on["@_target"];
      } else if (on.go) {
        skState.on[event] = parseBranches(on.go, name);
      } else {
        throw new Error(`<on event="${event}"> in state '${name}' has no target or guarded <go> children`);
      }
    }
  }

  return skState;
}

function parseBranches(gos: any[], stateName: string): GuardedTransition[] {
  return gos.map((g: any): GuardedTransition => {
    const target = g["@_target"];
    if (!target) throw new Error(`<go> in state '${stateName}' missing target`);
    const gt: GuardedTransition = { target };

    const retryKey = g["@_retries-key"];
    const retryMax = g["@_retries-max"];
    const expr = g["@_guard"];

    if (expr && (retryKey || retryMax)) {
      throw new Error(`<go> in state '${stateName}': cannot mix 'guard' with 'retries-key/-max'`);
    }
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
  const version = skeleton.formatVersion || "0.1";
  lines.push(`<skeleton id="${esc(skeleton.id)}" initial="${esc(skeleton.initial)}" format-version="${esc(version)}">`);
  lines.push(`  <description>${esc(skeleton.description)}</description>`);
  lines.push(`  <usage>${esc(skeleton.usage)}</usage>`);

  for (const [name, state] of Object.entries(skeleton.states)) {
    lines.push("");
    if (state.type === "final") {
      lines.push(`  <state name="${esc(name)}" type="final" status="${state.status || "success"}" />`);
      continue;
    }

    const stateAttrs = [`name="${esc(name)}"`, `type="${state.type}"`];
    if (state.timeout) stateAttrs.push(`timeout="${esc(state.timeout)}"`);
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
      for (const [event, target] of Object.entries(state.on || {})) {
        if (typeof target === "string") lines.push(`    <on event="${esc(event)}" target="${esc(target)}" />`);
        else {
          lines.push(`    <on event="${esc(event)}">`);
          for (const gt of target) lines.push(`      ${emitGo(gt)}`);
          lines.push(`    </on>`);
        }
      }
      lines.push(`  </state>`);
      continue;
    }

    if (state.type === "call") {
      if (state.callSkeleton) stateAttrs.push(`skeleton="${esc(state.callSkeleton)}"`);
      if (state.callArgsExpr) stateAttrs.push(`args="${esc(state.callArgsExpr)}"`);
      lines.push(`  <state ${stateAttrs.join(" ")}>`);
      for (const [event, target] of Object.entries(state.on || {})) {
        if (typeof target === "string") lines.push(`    <on event="${esc(event)}" target="${esc(target)}" />`);
        else {
          lines.push(`    <on event="${esc(event)}">`);
          for (const gt of target) lines.push(`      ${emitGo(gt)}`);
          lines.push(`    </on>`);
        }
      }
      lines.push(`  </state>`);
      continue;
    }

    if (state.type === "parallel") {
      if (state.overExpr) stateAttrs.push(`over="${esc(state.overExpr)}"`);
      if (state.parallelBranch) stateAttrs.push(`branch="${esc(state.parallelBranch)}"`);
      if (state.parallelJoin) stateAttrs.push(`join="${esc(state.parallelJoin)}"`);
      if (state.concurrency !== undefined) stateAttrs.push(`concurrency="${state.concurrency}"`);
      if (state.on && Object.keys(state.on).length) {
        lines.push(`  <state ${stateAttrs.join(" ")}>`);
        for (const [event, target] of Object.entries(state.on)) {
          if (typeof target === "string") lines.push(`    <on event="${esc(event)}" target="${esc(target)}" />`);
        }
        lines.push(`  </state>`);
      } else {
        lines.push(`  <state ${stateAttrs.join(" ")} />`);
      }
      continue;
    }
    if (state.type === "loop") {
      if (state.parallelJoin) stateAttrs.push(`join="${esc(state.parallelJoin)}"`);
      if (state.maxIterations !== undefined) stateAttrs.push(`max="${state.maxIterations}"`);
      if (state.exitExpr) stateAttrs.push(`exit="${esc(state.exitExpr)}"`);
      lines.push(`  <state ${stateAttrs.join(" ")}>`);
      for (const s of state.loopSteps || []) lines.push(`    <step state="${esc(s)}" />`);
      for (const [event, target] of Object.entries(state.on || {})) {
        if (typeof target === "string") lines.push(`    <on event="${esc(event)}" target="${esc(target)}" />`);
      }
      lines.push(`  </state>`);
      continue;
    }
    lines.push(`  <state ${stateAttrs.join(" ")}>`);

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

    for (const [event, target] of Object.entries(state.on || {})) {
      if (typeof target === "string") {
        lines.push(`    <on event="${esc(event)}" target="${esc(target)}" />`);
      } else {
        lines.push(`    <on event="${esc(event)}">`);
        for (const gt of target) lines.push(`      ${emitGo(gt)}`);
        lines.push(`    </on>`);
      }
    }
    lines.push(`  </state>`);
  }

  lines.push("</skeleton>");
  return lines.join("\n") + "\n";
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
